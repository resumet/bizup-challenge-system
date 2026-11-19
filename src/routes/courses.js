'use strict';
const express = require('express');
const crypto = require('crypto');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');
const { get, all, run, tx, uuid, now, nextCode } = require('../db');
const U = require('../util');
const { E } = U;
const A = require('../auth');
const P = require('../progress');
const F = require('../files');
const AC = require('../access');
const { storage } = require('../storage');
const { correctStudent } = require('../students');
const { fetchRoster } = require('../rosterApi');

const r = express.Router();
const STATES = ['READY', 'ACTIVE', 'ENDED', 'ARCHIVED'];

async function instructorsOf(courseId) {
  return all(`SELECT i.id, i.code, i.name, a.email, a.status AS account_status FROM course_instructors ci
    JOIN instructors i ON i.id = ci.instructor_id JOIN staff_accounts a ON a.id = i.staff_id
    WHERE ci.course_id = ? AND ci.status = 'ACTIVE' ORDER BY ci.assigned_at`, courseId);
}
async function courseView(c, user, stats) {
  const v = {
    id: c.id, code: c.code, title: c.title, cohort_label: c.cohort_label, description: c.description, state: c.state,
    starts_on: c.starts_on, ends_on: c.ends_on, version: c.version, created_at: c.created_at, updated_at: c.updated_at,
    instructors: await instructorsOf(c.id),
  };
  if (user.isAdmin) v.admin_memo = c.admin_memo;
  if (stats) v.stats = stats;
  v.no_instructor_warning = c.state === 'ACTIVE' && v.instructors.length === 0;
  return v;
}

// ---------- 강의 ----------
r.get('/courses', A.requireStaff, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const state = STATES.includes(req.query.state) ? req.query.state : null;
  const conds = []; const params = [];
  if (!req.user.isAdmin) {
    if (!req.user.instructorId) return res.json({ items: [] });
    conds.push(`EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status = 'ACTIVE')`);
    params.push(req.user.instructorId);
  }
  if (q) { conds.push('(c.title ILIKE ? OR c.cohort_label ILIKE ? OR c.code ILIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (state) { conds.push('c.state = ?'); params.push(state); } else if (req.query.include_archived !== '1') conds.push(`c.state != 'ARCHIVED'`);
  if (req.query.instructor_id) {
    conds.push(`EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status = 'ACTIVE')`);
    params.push(String(req.query.instructor_id));
  }
  if (req.query.instructor_q) {
    conds.push(`EXISTS (SELECT 1 FROM course_instructors ci JOIN instructors i ON i.id = ci.instructor_id WHERE ci.course_id = c.id AND ci.status = 'ACTIVE' AND i.name ILIKE ?)`);
    params.push(`%${req.query.instructor_q}%`);
  }
  const rows = await all(`SELECT * FROM courses c ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY c.created_at DESC LIMIT 500`, ...params);
  const stats = await P.courseStats(rows.map((x) => x.id));
  res.json({ items: await Promise.all(rows.map((c) => courseView(c, req.user, stats.get(c.id)))) });
});

function courseInput(body, existing) {
  const o = {};
  o.title = body.title !== undefined ? U.requireStr(body.title, '강의명', 200) : existing.title;
  o.cohort_label = body.cohort_label !== undefined ? U.requireStr(body.cohort_label, '기수명', 100) : existing.cohort_label;
  o.description = body.description !== undefined ? U.str(body.description, 5000) : existing.description ?? null;
  o.admin_memo = body.admin_memo !== undefined ? U.str(body.admin_memo, 5000) : existing.admin_memo ?? null;
  o.state = body.state !== undefined ? body.state : (existing.state || 'READY');
  if (!STATES.includes(o.state)) throw E.invalid('운영 상태 값이 올바르지 않습니다.');
  for (const k of ['starts_on', 'ends_on']) {
    o[k] = body[k] !== undefined ? (body[k] || null) : existing[k] ?? null;
    if (o[k] && !U.isValidDate(o[k])) throw E.invalid('날짜 형식이 올바르지 않습니다.');
  }
  if (o.starts_on && o.ends_on && o.starts_on > o.ends_on) throw E.invalid('시작일이 종료일보다 늦을 수 없습니다.');
  return o;
}

r.post('/courses', A.requireAdmin, async (req, res) => {
  const o = courseInput(req.body, {});
  const ins = Array.isArray(req.body.instructor_ids) ? [...new Set(req.body.instructor_ids.map(String))] : [];
  const out = await tx(async () => {
    if (!req.body.confirm_duplicate && await get('SELECT 1 AS ok FROM courses WHERE title = ? AND cohort_label = ?', o.title, o.cohort_label)) {
      throw E.conflict('같은 강의명·기수의 강의가 이미 있습니다. 그래도 생성하려면 확인해주세요.', { reason: 'POSSIBLE_DUPLICATE' });
    }
    for (const iid of ins) if (!(await get('SELECT 1 AS ok FROM instructors WHERE id = ?', iid))) throw E.invalid('존재하지 않는 강사가 포함되어 있습니다.');
    if (o.state === 'ACTIVE' && ins.length === 0) throw E.invalid('진행 중으로 전환하려면 강사를 1명 이상 배정해주세요.');
    const id = uuid(); const code = await nextCode('CRS'); const t = now();
    await run(`INSERT INTO courses(id, code, title, cohort_label, description, state, starts_on, ends_on, admin_memo, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, code, o.title, o.cohort_label, o.description, o.state, o.starts_on, o.ends_on, o.admin_memo, req.user.id, req.user.id, t, t);
    for (const iid of ins) await run(`INSERT INTO course_instructors(course_id, instructor_id, status, assigned_at) VALUES(?,?,'ACTIVE',?)`, id, iid, t);
    await A.audit(req, { courseId: id, targetType: 'COURSE', targetId: id, action: 'COURSE_CREATED', changed: { title: o.title, cohort_label: o.cohort_label } });
    return courseView(await get('SELECT * FROM courses WHERE id = ?', id), req.user);
  });
  res.status(201).json(out);
});

r.get('/courses/:id', A.requireStaff, async (req, res) => {
  const c = await AC.loadCourseForStaff(req.user, req.params.id);
  res.json(await courseView(c, req.user, (await P.courseStats([c.id])).get(c.id)));
});

r.patch('/courses/:id', A.requireAdmin, async (req, res) => {
  const out = await tx(async () => {
    const c = await get('SELECT * FROM courses WHERE id = ? FOR UPDATE', req.params.id);
    if (!c) throw E.notFound();
    if (req.body.version !== undefined && Number(req.body.version) !== c.version) {
      throw E.conflict('다른 변경 내용이 있습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.', { reason: 'VERSION_CONFLICT', latest: await courseView(c, req.user) });
    }
    const o = courseInput(req.body, c);
    if (o.state === 'ACTIVE' && c.state !== 'ACTIVE' && (await instructorsOf(c.id)).length === 0) throw E.invalid('진행 중으로 전환하려면 강사를 1명 이상 배정해주세요.');
    const changed = {};
    for (const k of Object.keys(o)) if ((o[k] ?? null) !== (c[k] ?? null)) changed[k] = [c[k], o[k]];
    await run(`UPDATE courses SET title=?, cohort_label=?, description=?, state=?, starts_on=?, ends_on=?, admin_memo=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`,
      o.title, o.cohort_label, o.description, o.state, o.starts_on, o.ends_on, o.admin_memo, req.user.id, now(), c.id);
    if (Object.keys(changed).length) await A.audit(req, { courseId: c.id, targetType: 'COURSE', targetId: c.id, action: 'COURSE_UPDATED', changed });
    return courseView(await get('SELECT * FROM courses WHERE id = ?', c.id), req.user);
  });
  res.json(out);
});

r.put('/courses/:id/instructors/:iid', A.requireAdmin, async (req, res) => {
  await tx(async () => {
    const c = await get('SELECT * FROM courses WHERE id = ?', req.params.id);
    const i = await get('SELECT * FROM instructors WHERE id = ?', req.params.iid);
    if (!c || !i) throw E.notFound();
    const ex = await get('SELECT * FROM course_instructors WHERE course_id = ? AND instructor_id = ? FOR UPDATE', c.id, i.id);
    if (ex && ex.status === 'ACTIVE') return;
    await run(`INSERT INTO course_instructors(course_id, instructor_id, status, assigned_at) VALUES(?,?,'ACTIVE',?)
      ON CONFLICT (course_id, instructor_id) DO UPDATE SET status = 'ACTIVE', assigned_at = excluded.assigned_at, removed_at = NULL`, c.id, i.id, now());
    await A.audit(req, { courseId: c.id, targetType: 'COURSE', targetId: c.id, action: 'INSTRUCTOR_ASSIGNED', changed: { instructor: i.code } });
  });
  res.json({ instructors: await instructorsOf(req.params.id) });
});
r.delete('/courses/:id/instructors/:iid', A.requireAdmin, async (req, res) => {
  const out = await tx(async () => {
    const c = await get('SELECT * FROM courses WHERE id = ?', req.params.id);
    const i = await get('SELECT * FROM instructors WHERE id = ?', req.params.iid);
    if (!c || !i) throw E.notFound();
    await run(`UPDATE course_instructors SET status = 'REMOVED', removed_at = ? WHERE course_id = ? AND instructor_id = ? AND status = 'ACTIVE'`, now(), c.id, i.id);
    await A.audit(req, { courseId: c.id, targetType: 'COURSE', targetId: c.id, action: 'INSTRUCTOR_REMOVED', changed: { instructor: i.code } });
    const list = await instructorsOf(c.id);
    return { instructors: list, no_instructor_warning: c.state === 'ACTIVE' && list.length === 0 };
  });
  res.json(out);
});

// ---------- 수강생 명단 ----------
// 학생은 강의마다 따로 둔다(전체 시스템 공유 없음). 같은 사람이 두 강의를 들으면 강의별 학생이 각각 생긴다.
// 등록 경로: (1) 관리자 — 개별 등록·엑셀 업로드·외부 API 가져오기
//            (2) 담당 강사 — 자신이 배정된 강의에 한해 엑셀 업로드·개별 등록·수정·삭제(비활성화)
function enrollmentRow(e, user) {
  return {
    id: e.id, status: e.status, enrolled_at: e.enrolled_at, deactivated_at: e.deactivated_at,
    reason: e.reason, admin_memo: user.isAdmin ? e.admin_memo : undefined,
    student: { id: e.student_id, code: e.code, name: e.name, status: e.student_status, phone: user.isAdmin ? U.formatPhone(e.normalized_phone) : U.maskPhone(e.normalized_phone) },
  };
}
r.get('/courses/:id/enrollments', A.requireStaff, async (req, res) => {
  const c = await AC.loadCourseForStaff(req.user, req.params.id);
  const { page, size, offset } = U.pageParams(req.query);
  const status = ['ACTIVE', 'INACTIVE', 'ALL'].includes(req.query.status) ? req.query.status : 'ACTIVE';
  const q = U.normalizeName(req.query.q || '');
  const digits = q.replace(/\D/g, '');
  const conds = ['e.course_id = ?']; const params = [c.id];
  if (status !== 'ALL') { conds.push('e.status = ?'); params.push(status); }
  if (q) {
    conds.push(`(s.normalized_name ILIKE ? OR s.code ILIKE ? ${digits.length >= 4 ? 'OR s.normalized_phone LIKE ?' : ''})`);
    params.push(`%${q}%`, `%${q}%`); if (digits.length >= 4) params.push(`%${digits}%`);
  }
  const where = conds.join(' AND ');
  const total = (await get(`SELECT COUNT(*) AS n FROM enrollments e JOIN students s ON s.id = e.student_id WHERE ${where}`, ...params)).n;
  const rows = await all(`SELECT e.*, s.code, s.name, s.normalized_phone, s.status AS student_status FROM enrollments e JOIN students s ON s.id = e.student_id
    WHERE ${where} ORDER BY s.normalized_name, s.code LIMIT ? OFFSET ?`, ...params, size, offset);
  const pubs = await P.publishedAssignments(c.id);
  const cells = await P.cellMatrix(c.id, rows.map((x) => x.id), pubs);
  res.json({
    items: rows.map((e) => {
      const v = enrollmentRow(e, req.user);
      let done = 0; let unread = 0;
      for (const a of pubs) { const cell = cells.get(e.id + '|' + a.id); if (cell.completed) done++; unread += cell.unread_feedback; }
      v.progress = { completed: done, total: pubs.length, rate: U.pct(done, pubs.length) };
      v.unread_feedback = unread;
      return v;
    }), total, page, size,
  });
});

async function createStudent(courseId, name, phone, hash) {
  const id = uuid(); const t = now();
  await run(`INSERT INTO students(id, code, name, normalized_name, normalized_phone, status, course_id, created_at, updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)`,
    id, await nextCode('STU'), name, name, phone, courseId, t, t);
  await run('INSERT INTO student_credentials(student_id, password_hash) VALUES(?,?)', id, hash);
  return get('SELECT * FROM students WHERE id = ?', id);
}
async function createEnrollment(req, courseId, studentId, memo, source) {
  const id = uuid();
  await run(`INSERT INTO enrollments(id, course_id, student_id, status, enrolled_at, admin_memo) VALUES(?,?,?,'ACTIVE',?,?)`, id, courseId, studentId, now(), memo);
  await run(`INSERT INTO enrollment_events(enrollment_id, action, actor_id, reason, created_at) VALUES(?,?,?,?,?)`, id, 'ENROLLED', req.user.id, source, now());
  await A.audit(req, { courseId, targetType: 'ENROLLMENT', targetId: id, action: 'ENROLLED', changed: { source } });
  return id;
}

// 7.4 개별 등록 (관리자·담당 강사). 같은 전화번호 중복은 이 강의 안에서만 확인한다.
r.post('/courses/:id/enrollments', A.requireStaff, async (req, res) => {
  const c = await AC.loadCourseForStaff(req.user, req.params.id);
  // 등록 메모는 관리자 전용 필드이므로 강사 입력은 저장하지 않는다
  const memo = req.user.isAdmin ? U.str(req.body.memo, 1000) : null;
  if (req.body.student_id) throw E.invalid('학생은 강의마다 따로 등록합니다. 이름과 전화번호로 등록해주세요.');
  const name = U.normalizeName(U.str(req.body.name, 50));
  if (!name) throw E.invalid('이름을 입력해주세요.');
  const phone = U.normalizePhone(req.body.phone);
  if (!phone) throw E.invalid(U.phoneError(req.body.phone));
  const inCourse = 'SELECT * FROM students WHERE course_id = ? AND normalized_phone = ?';
  const hash = (await get(inCourse, c.id, phone)) ? null : await A.hashPassword(phone, 'STUDENT');
  const out = await tx(async () => {
    let s = await get(inCourse + ' FOR UPDATE', c.id, phone);
    if (s) {
      if (s.normalized_name !== name) {
        throw E.conflict('이 강의에 같은 전화번호로 다른 이름의 수강생이 이미 있습니다. 이름과 번호를 확인해주세요.',
          { reason: 'NAME_CONFLICT', existing: { code: s.code, name: s.name } });
      }
      if (s.status !== 'ACTIVE') throw E.conflict('비활성화된 수강생입니다. 관리자가 전체 학생 관리에서 검토 후 활성화해야 합니다.', { reason: 'STUDENT_INACTIVE' });
      const ex = await get('SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?', c.id, s.id);
      if (ex && ex.status === 'ACTIVE') throw E.conflict('이미 등록된 수강생입니다. 기존 기록을 유지합니다.', { reason: 'ALREADY_ENROLLED' });
      if (ex) throw E.conflict('비활성화된 수강 등록이 있습니다. 재활성화가 필요합니다.', { reason: 'NEEDS_REACTIVATION', enrollment_id: ex.id });
      throw E.conflict('수강 등록이 없는 학생 정보가 남아 있습니다. 관리자에게 문의해주세요.', { reason: 'ORPHAN_STUDENT' });
    }
    if (!hash) throw E.conflict('잠시 후 다시 시도해주세요.');
    s = await createStudent(c.id, name, phone, hash);
    await A.audit(req, { courseId: c.id, targetType: 'STUDENT', targetId: s.id, action: 'STUDENT_CREATED', changed: { code: s.code } });
    const eid = await createEnrollment(req, c.id, s.id, memo, 'MANUAL');
    return { enrollment_id: eid, student: { id: s.id, code: s.code, name: s.name } };
  });
  res.status(201).json(out);
});

// 7.5 수강 등록 비활성화·재활성화 (관리자·담당 강사)
r.patch('/enrollments/:id/status', A.requireStaff, async (req, res) => {
  await AC.loadEnrollmentForStaff(req.user, req.params.id);
  const status = req.body.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw E.invalid('상태 값이 올바르지 않습니다.');
  const reason = (U.str(req.body.reason, 500) || '').trim();
  if (status === 'INACTIVE' && !reason) throw E.invalid('비활성화 사유를 입력해주세요. (환불, 중도탈퇴, 오등록 등)');
  const out = await tx(async () => {
    const e = await get('SELECT * FROM enrollments WHERE id = ? FOR UPDATE', req.params.id);
    if (!e) throw E.notFound();
    if (e.status === status) return { id: e.id, status };
    if (status === 'ACTIVE') {
      const s = await get('SELECT status FROM students WHERE id = ?', e.student_id);
      if (s.status !== 'ACTIVE' && !req.user.isAdmin) throw E.conflict('비활성화된 수강생입니다. 관리자에게 문의해주세요.', { reason: 'STUDENT_INACTIVE' });
    }
    if (status === 'INACTIVE') await run(`UPDATE enrollments SET status = 'INACTIVE', deactivated_at = ?, reason = ? WHERE id = ?`, now(), reason, e.id);
    else await run(`UPDATE enrollments SET status = 'ACTIVE', deactivated_at = NULL, reason = ? WHERE id = ?`, reason || null, e.id);
    await run(`INSERT INTO enrollment_events(enrollment_id, action, actor_id, reason, created_at) VALUES(?,?,?,?,?)`, e.id, status === 'ACTIVE' ? 'REACTIVATED' : 'DEACTIVATED', req.user.id, reason, now());
    await A.audit(req, { courseId: e.course_id, targetType: 'ENROLLMENT', targetId: e.id, action: status === 'ACTIVE' ? 'ENROLLMENT_REACTIVATED' : 'ENROLLMENT_DEACTIVATED', reason });
    return { id: e.id, status };
  });
  res.json(out);
});
r.patch('/enrollments/:id', A.requireAdmin, async (req, res) => {
  const e = await get('SELECT * FROM enrollments WHERE id = ?', req.params.id);
  if (!e) throw E.notFound();
  await run('UPDATE enrollments SET admin_memo = ? WHERE id = ?', U.str(req.body.admin_memo, 1000), e.id);
  res.json({ ok: true });
});

// 수강생 이름·전화번호 수정 (관리자·담당 강사). 학생은 이 강의에만 속하므로 다른 강의에는 영향이 없다.
r.patch('/enrollments/:id/student', A.requireStaff, async (req, res) => {
  const e = await AC.loadEnrollmentForStaff(req.user, req.params.id);
  const s = await get('SELECT * FROM students WHERE id = ?', e.student_id);
  res.json(await correctStudent(req, s, req.body, { allowStatus: req.user.isAdmin, courseId: e.course_id }));
});

// 수강 등록 삭제 (관리자·담당 강사): 잘못 등록한 경우를 위한 것으로, 수행 기록이 하나도 없을 때만 지운다.
// 체크·제출·피드백 기록이 있으면 기록 보존을 위해 비활성화를 사용해야 한다.
r.delete('/enrollments/:id', A.requireStaff, async (req, res) => {
  await AC.loadEnrollmentForStaff(req.user, req.params.id);
  const out = await tx(async () => {
    const e = await get('SELECT * FROM enrollments WHERE id = ? FOR UPDATE', req.params.id);
    if (!e) throw E.notFound();
    const activity = await get(`SELECT
        (SELECT COUNT(*) FROM submissions WHERE enrollment_id = ?) AS subs,
        (SELECT COUNT(*) FROM feedback WHERE enrollment_id = ?) AS fb,
        (SELECT COUNT(*) FROM progress_events pe JOIN task_progress tp ON tp.id = pe.task_progress_id WHERE tp.enrollment_id = ?) AS events,
        (SELECT COUNT(*) FROM task_progress WHERE enrollment_id = ? AND (started_at IS NOT NULL OR is_completed = 1)) AS started`, e.id, e.id, e.id, e.id);
    if (activity.subs || activity.fb || activity.events || activity.started) {
      throw E.conflict('과제 수행·제출·피드백 기록이 있어 삭제할 수 없습니다. 대신 비활성화하면 기록을 보존하면서 접근을 막을 수 있습니다.', { reason: 'HAS_ACTIVITY' });
    }
    const s = await get('SELECT * FROM students WHERE id = ? FOR UPDATE', e.student_id);
    await run('DELETE FROM item_progress WHERE task_progress_id IN (SELECT id FROM task_progress WHERE enrollment_id = ?)', e.id);
    await run('DELETE FROM task_progress WHERE enrollment_id = ?', e.id);
    await run('DELETE FROM enrollment_events WHERE enrollment_id = ?', e.id);
    await run('UPDATE import_rows SET enrollment_id_optional = NULL WHERE enrollment_id_optional = ?', e.id);
    await run('DELETE FROM enrollments WHERE id = ?', e.id);
    // 학생은 이 강의에만 속하므로 함께 삭제해 잘못 입력된 이름·번호가 남지 않게 한다
    let studentDeleted = false;
    const rest = (await get('SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ?', s.id)).n;
    const reads = (await get('SELECT COUNT(*) AS n FROM feedback_reads WHERE student_id = ?', s.id)).n;
    if (!rest && !reads) {
      await A.revokeSubjectSessions('STUDENT', s.id);
      await run('UPDATE import_rows SET student_id_optional = NULL WHERE student_id_optional = ?', s.id);
      await run('DELETE FROM student_credentials WHERE student_id = ?', s.id);
      await run('DELETE FROM students WHERE id = ?', s.id);
      studentDeleted = true;
    }
    await A.audit(req, { courseId: e.course_id, targetType: 'ENROLLMENT', targetId: e.id, action: 'ENROLLMENT_DELETED',
      changed: { student: s.code, name: s.name, student_deleted: studentDeleted }, reason: U.str(req.body && req.body.reason, 500) });
    return { deleted: true, student_deleted: studentDeleted };
  });
  res.json(out);
});

// 5.3 학생 로그인 정보 확인 (조회 이력 기록)
r.post('/enrollments/:id/login-info/reveal', A.requireStaff, async (req, res) => {
  const e = await AC.loadEnrollmentForStaff(req.user, req.params.id);
  const s = await get('SELECT * FROM students WHERE id = ?', e.student_id);
  if (!req.user.isAdmin && (e.status !== 'ACTIVE' || s.status !== 'ACTIVE')) {
    throw E.forbidden('비활성 수강생의 로그인 정보는 확인할 수 없습니다.');
  }
  await A.audit(req, { courseId: e.course_id, targetType: 'STUDENT', targetId: s.id, action: 'LOGIN_INFO_REVEALED', changed: { enrollment_id: e.id }, restricted: true });
  res.json({ code: s.code, login_id: s.name, login_password: s.normalized_phone, phone_display: U.formatPhone(s.normalized_phone) });
});

// ---------- 명단 업로드·외부 API 가져오기 (7장) ----------
r.get('/import-template.csv', A.requireStaff, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('수강생_명단_양식.csv')}`);
  res.send('﻿이름,전화번호,수강 등록 메모\n홍길동,010-1234-5678,\n');
});

function decodeCsv(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const u = buf.toString('utf8');
  if (!u.includes('�')) return u;
  const k = iconv.decode(buf, 'cp949');
  if (k.includes('�')) throw E.invalid('CSV 인코딩을 해석할 수 없습니다. UTF-8 형식으로 저장한 뒤 다시 업로드해주세요.');
  return k;
}
function readWorkbook(buf, name) {
  try {
    if (name.toLowerCase().endsWith('.csv')) return XLSX.read(decodeCsv(buf), { type: 'string', raw: true });
    return XLSX.read(buf, { type: 'buffer', cellDates: false });
  } catch (e) {
    if (e.status) throw e;
    throw E.invalid('파일을 읽을 수 없습니다. 표준 양식(.xlsx 또는 CSV)을 사용해주세요.');
  }
}
function sheetRows(wb, sheet) {
  const ws = wb.Sheets[sheet];
  if (!ws) throw E.invalid('선택한 시트를 찾을 수 없습니다.');
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false })
    .map((row) => row.map((v) => String(v ?? '')));
}
function guessMapping(headers) {
  const find = (re) => { const i = headers.findIndex((h) => re.test(String(h).replace(/\s/g, ''))); return i >= 0 ? i : null; };
  return { name: find(/^(이름|성명|수강생명|name)$/i) ?? find(/이름|성명/), phone: find(/전화|휴대폰|핸드폰|연락처|phone|mobile/i), memo: find(/메모|memo|비고/i) };
}

// 행 분류: 이 강의의 학생·등록만 조회해 한 번에 분류하고 결과를 일괄 갱신한다 (대량 명단에서도 왕복 횟수 일정).
// 다른 강의에 같은 전화번호가 있어도 별개 학생이므로 신규로 분류한다.
async function classifyJob(job) {
  const rows = await all('SELECT * FROM import_rows WHERE import_job_id = ? ORDER BY row_number', job.id);
  const prepared = rows.map((row) => {
    const name = U.normalizeName(row.raw_name);
    const phone = U.normalizePhone(row.raw_phone);
    let cls = null; let error = null;
    if (row.excluded) cls = 'EXCLUDED';
    else if (!name && !String(row.raw_phone || '').trim()) { cls = 'ERROR'; error = '이름과 전화번호가 비어 있습니다.'; }
    else if (!name) { cls = 'ERROR'; error = '이름이 비어 있습니다.'; }
    else if (!phone) { cls = 'ERROR'; error = U.phoneError(row.raw_phone); }
    return { row, name, phone, cls, error, student_id: null, enrollment_id: null };
  });
  const groups = new Map();
  prepared.filter((p) => !p.cls).forEach((p) => { if (!groups.has(p.phone)) groups.set(p.phone, []); groups.get(p.phone).push(p); });
  for (const list of groups.values()) {
    const names = new Set(list.map((p) => p.name));
    if (names.size > 1) list.forEach((p) => { p.cls = 'CONFLICT_IN_FILE'; p.error = '같은 명단 안에 같은 전화번호로 서로 다른 이름이 있습니다.'; });
    else list.slice(1).forEach((p) => { p.cls = 'DUP_IN_FILE'; p.error = `명단 안 중복 행입니다. (${list[0].row.row_number}행만 처리)`; });
  }
  const phones = prepared.filter((p) => !p.cls).map((p) => p.phone);
  const students = phones.length ? await all('SELECT * FROM students WHERE course_id = ? AND normalized_phone = ANY(?::text[])', job.course_id, phones) : [];
  const sByPhone = new Map(students.map((s) => [s.normalized_phone, s]));
  const enrs = students.length ? await all('SELECT * FROM enrollments WHERE course_id = ? AND student_id = ANY(?::text[])', job.course_id, students.map((s) => s.id)) : [];
  const eByStudent = new Map(enrs.map((e) => [e.student_id, e]));
  for (const p of prepared) {
    if (p.cls) continue;
    const s = sByPhone.get(p.phone);
    if (!s) { p.cls = 'NEW'; continue; }
    if (s.normalized_name !== p.name) {
      p.cls = 'NAME_CONFLICT';
      p.error = `이 강의의 기존 수강생과 이름이 다릅니다. 확인 후 등록해주세요. (기존: ${s.name}, ${s.code})`;
      continue;
    }
    if (s.status !== 'ACTIVE') { p.cls = 'STUDENT_INACTIVE'; p.error = '비활성화된 수강생입니다. 관리자 검토가 필요합니다.'; continue; }
    const e = eByStudent.get(s.id);
    p.student_id = s.id;
    if (!e) { p.cls = 'ERROR'; p.error = '수강 등록이 없는 학생 정보가 남아 있습니다. 관리자에게 문의해주세요.'; continue; }
    p.enrollment_id = e.id;
    if (e.status === 'ACTIVE') { p.cls = 'ALREADY_ENROLLED'; p.error = '이미 등록된 수강생입니다. 기존 기록을 유지합니다.'; } else { p.cls = 'NEEDS_REACTIVATION'; p.error = '비활성화된 수강 등록입니다. 재활성화가 필요합니다.'; }
  }
  if (!prepared.length) return;
  const col = (f) => prepared.map(f);
  await run(`UPDATE import_rows r SET normalized_name = u.nn, normalized_phone = u.np, classification = u.cls, error = u.err,
      student_id_optional = u.sid, enrollment_id_optional = u.eid
    FROM unnest(?::int[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[]) AS u(rn, nn, np, cls, err, sid, eid)
    WHERE r.import_job_id = ? AND r.row_number = u.rn`,
  col((p) => p.row.row_number), col((p) => p.name), col((p) => p.phone), col((p) => p.cls), col((p) => p.error),
  col((p) => p.student_id), col((p) => p.enrollment_id), job.id);
}
const COMMITTABLE = ['NEW'];
async function jobView(jobId) {
  const j = await get('SELECT j.*, c.code AS course_code, c.title AS course_title, c.cohort_label FROM import_jobs j JOIN courses c ON c.id = j.course_id WHERE j.id = ?', jobId);
  const rows = (await all('SELECT * FROM import_rows WHERE import_job_id = ? ORDER BY row_number', jobId)).map((x) => ({
    row_number: x.row_number, raw_name: x.raw_name, raw_phone: x.raw_phone, memo: x.memo, name: x.normalized_name,
    phone: x.normalized_phone ? U.formatPhone(x.normalized_phone) : null, classification: x.classification, error: x.error,
    excluded: !!x.excluded, result: x.result, result_message: x.result_message,
  }));
  const counts = {};
  rows.forEach((x) => { counts[x.classification] = (counts[x.classification] || 0) + 1; });
  const processed = rows.filter((x) => x.result).length;
  return {
    id: j.id, course_id: j.course_id, course_code: j.course_code, course_title: j.course_title, cohort_label: j.cohort_label,
    source_type: j.source_type || 'FILE',
    state: j.state, original_name: j.original_name, sheet_names: JSON.parse(j.sheet_names || '[]'), sheet_name: j.sheet_name,
    headers: JSON.parse(j.headers || '[]'), mapping: JSON.parse(j.mapping || '{}'), created_at: j.created_at, committed_at: j.committed_at,
    preview_counts: counts, committable: rows.filter((x) => COMMITTABLE.includes(x.classification)).length,
    progress: { processed, total: rows.length },
    result_counts: j.counts ? JSON.parse(j.counts) : null, rows,
  };
}
// rows: [{ rn, name, phone, memo }]
async function insertRows(job, rows) {
  if (rows.length > F.LIMITS.rosterRows) throw E.invalid(`명단은 최대 ${F.LIMITS.rosterRows}행까지 등록할 수 있습니다.`);
  await run('DELETE FROM import_rows WHERE import_job_id = ?', job.id);
  if (rows.length) {
    await run(`INSERT INTO import_rows(import_job_id, row_number, raw_name, raw_phone, memo, classification)
      SELECT ?, u.rn, u.nm, u.ph, u.memo, 'PENDING' FROM unnest(?::int[], ?::text[], ?::text[], ?::text[]) AS u(rn, nm, ph, memo)`,
    job.id, rows.map((x) => x.rn), rows.map((x) => String(x.name || '').slice(0, 100)), rows.map((x) => String(x.phone || '').slice(0, 40)),
    rows.map((x) => (x.memo ? String(x.memo).slice(0, 1000) : null)));
  }
}
async function loadRowsFromWorkbook(job, wb, sheet, mappingIn) {
  const data = sheetRows(wb, sheet);
  const headers = (data[0] || []).map((h) => String(h).trim());
  const mapping = mappingIn && mappingIn.name != null && mappingIn.phone != null ? mappingIn : guessMapping(headers);
  const body = data.slice(1);
  if (body.length > F.LIMITS.rosterRows) throw E.invalid(`명단은 최대 ${F.LIMITS.rosterRows}행까지 업로드할 수 있습니다.`);
  await run('UPDATE import_jobs SET sheet_name = ?, headers = ?, mapping = ? WHERE id = ?', sheet, JSON.stringify(headers), JSON.stringify(mapping), job.id);
  if (mapping.name == null || mapping.phone == null) { await insertRows(job, []); return; } // 열 매핑 필요
  const cell = (row, i) => (i == null || i === '' ? '' : String(row[Number(i)] ?? '').trim());
  await insertRows(job, body.map((row, i) => ({ rn: i + 2, name: cell(row, mapping.name), phone: cell(row, mapping.phone), memo: cell(row, mapping.memo) || null })));
  await classifyJob(job);
}
// 업로드 작업 접근: 관리자 또는 해당 강의의 담당 강사
async function loadJob(user, id, lock) {
  const j = await get('SELECT * FROM import_jobs WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), id);
  if (!j || !(await AC.canManageCourse(user, j.course_id))) throw E.notFound();
  return j;
}
async function readRosterFile(fileId) {
  const f = await get('SELECT * FROM file_assets WHERE id = ?', fileId);
  return { f, wb: readWorkbook(await storage().read(f.object_key), f.original_name) };
}
async function newJob(req, c, fields) {
  const id = uuid();
  await run(`INSERT INTO import_jobs(id, course_id, uploaded_by, state, file_id, file_hash, original_name, sheet_names, headers, mapping, source_type, source_id, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.id, req.user.id, 'PREVIEW', fields.file_id || null, fields.file_hash || null, fields.original_name,
  JSON.stringify(fields.sheet_names || []), JSON.stringify(fields.headers || []), JSON.stringify(fields.mapping || {}), fields.source_type, fields.source_id || null, now());
  return get('SELECT * FROM import_jobs WHERE id = ?', id);
}

// 미리보기: 업로드 완료된 명단 파일(file_id)을 읽어 검증만 수행한다. 학생·등록은 만들지 않는다.
r.post('/courses/:id/imports/preview', A.requireStaff, async (req, res) => {
  const c = await AC.loadCourseForStaff(req.user, req.params.id);
  const f = await F.loadOwnPending(req.user, req.body.file_id);
  if (f.purpose !== 'roster' || f.status !== 'UPLOADED') throw E.invalid('명단 파일 업로드가 완료되지 않았습니다. 다시 시도해주세요.');
  const buf = await storage().read(f.object_key);
  const wb = readWorkbook(buf, f.original_name);
  const out = await tx(async () => {
    await run(`UPDATE file_assets SET status = 'ATTACHED' WHERE id = ?`, f.id);
    const job = await newJob(req, c, { file_id: f.id, file_hash: crypto.createHash('sha256').update(buf).digest('hex'), original_name: f.original_name, sheet_names: wb.SheetNames, source_type: 'FILE' });
    let mapping = null;
    if (req.body.name_col != null && req.body.phone_col != null) mapping = { name: req.body.name_col, phone: req.body.phone_col, memo: req.body.memo_col ?? null };
    await loadRowsFromWorkbook(job, wb, req.body.sheet && wb.SheetNames.includes(req.body.sheet) ? req.body.sheet : wb.SheetNames[0], mapping);
    return job.id;
  });
  res.status(201).json(await jobView(out));
});

// 외부 API에서 명단 가져오기 (관리자): 연동 소스로 요청한 결과를 미리보기 작업으로 만든다.
r.post('/courses/:id/imports/api', A.requireAdmin, async (req, res) => {
  const c = await get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!c) throw E.notFound();
  const src = await get(`SELECT * FROM roster_sources WHERE id = ? AND status = 'ACTIVE'`, String(req.body.source_id || ''));
  if (!src) throw E.invalid('사용할 수 있는 연동 소스를 선택해주세요.');
  const param = U.str(req.body.param, 200) || '';
  const data = await fetchRoster(src, { course_code: c.code, course_title: c.title, cohort_label: c.cohort_label, param }, { maxRows: F.LIMITS.rosterRows });
  const out = await tx(async () => {
    const job = await newJob(req, c, {
      original_name: `API: ${src.name}${param ? ` (${param})` : ''}`, source_type: 'API', source_id: src.id,
      headers: [src.name_field, src.phone_field, src.memo_field].filter(Boolean), mapping: { name: src.name_field, phone: src.phone_field, memo: src.memo_field || null },
    });
    await insertRows(job, data.items.map((x, i) => ({ rn: i + 1, ...x })));
    await classifyJob(job);
    await run('UPDATE roster_sources SET last_used_at = ? WHERE id = ?', now(), src.id);
    await A.audit(req, { courseId: c.id, targetType: 'IMPORT', targetId: job.id, action: 'ROSTER_API_FETCHED', changed: { source: src.name, rows: data.items.length, param: param || undefined } });
    return job.id;
  });
  res.status(201).json(await jobView(out));
});

r.post('/imports/:id/remap', A.requireStaff, async (req, res) => {
  const job0 = await loadJob(req.user, req.params.id);
  if (job0.source_type === 'API') throw E.invalid('API로 가져온 명단은 연동 소스의 필드 설정을 바꾼 뒤 다시 가져와주세요.');
  const { wb } = await readRosterFile(job0.file_id);
  await tx(async () => {
    const job = await loadJob(req.user, req.params.id, true);
    if (job.state !== 'PREVIEW') throw E.conflict('이미 확정된 업로드입니다.');
    const m = req.body.mapping || {};
    const toIdx = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    await loadRowsFromWorkbook(job, wb, req.body.sheet || job.sheet_name, { name: toIdx(m.name), phone: toIdx(m.phone), memo: toIdx(m.memo) });
  });
  res.json(await jobView(req.params.id));
});

r.patch('/imports/:id/rows/:n', A.requireStaff, async (req, res) => {
  await tx(async () => {
    const job = await loadJob(req.user, req.params.id, true);
    if (job.state !== 'PREVIEW') throw E.conflict('이미 확정된 업로드입니다.');
    const row = await get('SELECT * FROM import_rows WHERE import_job_id = ? AND row_number = ?', job.id, Number(req.params.n));
    if (!row) throw E.notFound();
    await run('UPDATE import_rows SET raw_name = ?, raw_phone = ?, memo = ?, excluded = ? WHERE import_job_id = ? AND row_number = ?',
      req.body.name !== undefined ? U.str(req.body.name, 100) : row.raw_name,
      req.body.phone !== undefined ? U.str(req.body.phone, 40) : row.raw_phone,
      req.body.memo !== undefined ? U.str(req.body.memo, 1000) : row.memo,
      req.body.excluded !== undefined ? (req.body.excluded ? 1 : 0) : row.excluded, job.id, row.row_number);
    await classifyJob(job);
  });
  res.json(await jobView(req.params.id));
});

r.get('/imports/:id', A.requireStaff, async (req, res) => { await loadJob(req.user, req.params.id); res.json(await jobView(req.params.id)); });
r.get('/courses/:id/imports', A.requireStaff, async (req, res) => {
  const c = await AC.loadCourseForStaff(req.user, req.params.id);
  res.json({ items: (await all(`SELECT id, state, original_name, source_type, counts, created_at, committed_at FROM import_jobs WHERE course_id = ? ORDER BY created_at DESC LIMIT 50`, c.id))
    .map((j) => ({ ...j, counts: j.counts ? JSON.parse(j.counts) : null })) });
});

// 확정: 서버리스 실행 시간 제한을 고려해 호출마다 시간 예산 안에서 일부 행을 처리한다.
// 클라이언트는 state가 COMMITTING인 동안 같은 요청을 반복 호출한다(멱등). 각 행은 별도 트랜잭션으로
// 학생·인증·등록을 원자적으로 만들고, 확정 시점에 다시 중복을 검사한다.
const COMMIT_BUDGET_MS = Number(process.env.IMPORT_COMMIT_BUDGET_MS || 8000);
r.post('/imports/:id/commit', A.requireStaff, async (req, res) => {
  const started = Date.now();
  const job = await tx(async () => {
    const j = await loadJob(req.user, req.params.id, true);
    if (j.state !== 'PREVIEW') return j; // 이미 확정 중/완료면 그대로 진행
    await classifyJob(j);
    // 등록 대상이 아닌 행은 즉시 결과를 기록
    await run(`UPDATE import_rows SET result = CASE WHEN classification IN ('ALREADY_ENROLLED','DUP_IN_FILE','EXCLUDED') THEN 'SKIPPED' ELSE 'FAILED' END,
        result_message = COALESCE(error, CASE WHEN classification = 'EXCLUDED' THEN '제외한 행입니다.' END)
      WHERE import_job_id = ? AND classification != 'NEW'`, j.id);
    await run(`UPDATE import_jobs SET state = 'COMMITTING', idempotency_key = COALESCE(?, idempotency_key) WHERE id = ?`, U.str(req.body.idempotency_key, 100), j.id);
    return get('SELECT * FROM import_jobs WHERE id = ?', j.id);
  });
  if (job.state === 'COMMITTING') await processCommitChunk(req, job, started);
  res.status(202).json(await jobView(job.id));
});

async function processCommitChunk(req, job, started) {
  const actorReq = { user: req.user };
  const source = job.source_type === 'API' ? 'API' : 'IMPORT';
  // 등록 메모는 관리자 전용 필드: 강사가 올린 명단의 메모 열은 저장하지 않는다
  const keepMemo = req.user.isAdmin;
  const NAME_MSG = '이 강의의 기존 수강생과 이름이 다릅니다. 확인 후 등록해주세요.';
  while (Date.now() - started < COMMIT_BUDGET_MS) {
    const rows = await all('SELECT * FROM import_rows WHERE import_job_id = ? AND result IS NULL ORDER BY row_number LIMIT 50', job.id);
    if (!rows.length) break;
    const hashes = new Map();
    const toHash = rows.filter((x) => x.classification === 'NEW');
    for (let i = 0; i < toHash.length; i += 8) {
      await Promise.all(toHash.slice(i, i + 8).map(async (x) => hashes.set(x.normalized_phone, await A.hashPassword(x.normalized_phone, 'STUDENT'))));
    }
    for (const row0 of rows) {
      try {
        await tx(async () => {
          const row = await get('SELECT * FROM import_rows WHERE import_job_id = ? AND row_number = ? FOR UPDATE', job.id, row0.row_number);
          if (row.result) return null; // 다른 호출이 이미 처리
          let s = await get('SELECT * FROM students WHERE course_id = ? AND normalized_phone = ? FOR UPDATE', job.course_id, row.normalized_phone);
          let o;
          if (s && s.normalized_name !== row.normalized_name) o = { result: 'FAILED', msg: NAME_MSG };
          else if (s && s.status !== 'ACTIVE') o = { result: 'FAILED', msg: '비활성화된 수강생입니다. 관리자 검토가 필요합니다.' };
          else if (s) {
            const ex = await get('SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?', job.course_id, s.id);
            o = ex ? { result: 'SKIPPED', msg: ex.status === 'ACTIVE' ? '이미 등록된 수강생입니다. 기존 기록을 유지합니다.' : '재활성화가 필요합니다.', sid: s.id, eid: ex.id }
              : { result: 'FAILED', msg: '수강 등록이 없는 학생 정보가 남아 있습니다. 관리자에게 문의해주세요.' };
          } else {
            const h = hashes.get(row.normalized_phone) || await A.hashPassword(row.normalized_phone, 'STUDENT');
            s = await createStudent(job.course_id, row.normalized_name, row.normalized_phone, h);
            await A.audit(actorReq, { courseId: job.course_id, targetType: 'STUDENT', targetId: s.id, action: 'STUDENT_CREATED', changed: { code: s.code, import_job: job.id } });
            const eid = await createEnrollment(actorReq, job.course_id, s.id, keepMemo ? row.memo : null, source);
            o = { result: 'CREATED', msg: '신규 학생 등록', sid: s.id, eid };
          }
          await run(`UPDATE import_rows SET result = ?, result_message = ?, student_id_optional = COALESCE(?, student_id_optional), enrollment_id_optional = COALESCE(?, enrollment_id_optional)
            WHERE import_job_id = ? AND row_number = ?`, o.result, o.msg, o.sid, o.eid, job.id, row.row_number);
          return o;
        });
      } catch (e) {
        // 불완전한 학생·등록을 남기지 않도록 행 트랜잭션은 롤백되고, 실패 결과만 기록한다(재시도 가능)
        console.error('import row failed', job.id, row0.row_number, e.message);
        await run(`UPDATE import_rows SET result = 'FAILED', result_message = ? WHERE import_job_id = ? AND row_number = ? AND result IS NULL`,
          '처리 중 오류가 발생했습니다. 다시 업로드해주세요.', job.id, row0.row_number);
      }
      if (Date.now() - started >= COMMIT_BUDGET_MS) break;
    }
  }
  await tx(async () => {
    const j = await get('SELECT * FROM import_jobs WHERE id = ? FOR UPDATE', job.id);
    if (j.state !== 'COMMITTING') return;
    if ((await get('SELECT COUNT(*) AS n FROM import_rows WHERE import_job_id = ? AND result IS NULL', job.id)).n > 0) return;
    const counts = { created: 0, skipped: 0, failed: 0 };
    for (const x of await all('SELECT result, COUNT(*) AS n FROM import_rows WHERE import_job_id = ? GROUP BY result', job.id)) counts[x.result.toLowerCase()] = x.n;
    await run(`UPDATE import_jobs SET state = 'COMMITTED', counts = ?, committed_at = ? WHERE id = ?`, JSON.stringify(counts), now(), job.id);
    await A.audit(actorReq, { courseId: job.course_id, targetType: 'IMPORT', targetId: job.id, action: 'ROSTER_IMPORTED', changed: { ...counts, source } });
  });
}

module.exports = r;
module.exports.instructorsOf = instructorsOf;
