'use strict';
const express = require('express');
const fs = require('fs');
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

const r = express.Router();
const STATES = ['READY', 'ACTIVE', 'ENDED', 'ARCHIVED'];

function instructorsOf(courseId) {
  return all(`SELECT i.id, i.code, i.name, a.email, a.status AS account_status FROM course_instructors ci
    JOIN instructors i ON i.id = ci.instructor_id JOIN staff_accounts a ON a.id = i.staff_id
    WHERE ci.course_id = ? AND ci.status = 'ACTIVE' ORDER BY ci.assigned_at`, courseId);
}
function courseView(c, user, stats) {
  const v = {
    id: c.id, code: c.code, title: c.title, cohort_label: c.cohort_label, description: c.description, state: c.state,
    starts_on: c.starts_on, ends_on: c.ends_on, version: c.version, created_at: c.created_at, updated_at: c.updated_at,
    instructors: instructorsOf(c.id),
  };
  if (user.isAdmin) v.admin_memo = c.admin_memo;
  if (stats) v.stats = stats;
  v.no_instructor_warning = c.state === 'ACTIVE' && v.instructors.length === 0;
  return v;
}

// ---------- 강의 ----------
r.get('/courses', A.requireStaff, (req, res) => {
  const q = String(req.query.q || '').trim();
  const state = STATES.includes(req.query.state) ? req.query.state : null;
  const conds = []; const params = [];
  if (!req.user.isAdmin) {
    if (!req.user.instructorId) return res.json({ items: [] });
    conds.push(`EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status = 'ACTIVE')`);
    params.push(req.user.instructorId);
  }
  if (q) { conds.push('(c.title LIKE ? OR c.cohort_label LIKE ? OR c.code LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q.toUpperCase()}%`); }
  if (state) { conds.push('c.state = ?'); params.push(state); } else if (req.query.include_archived !== '1') conds.push(`c.state != 'ARCHIVED'`);
  if (req.query.instructor_id) {
    conds.push(`EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c.id AND ci.instructor_id = ? AND ci.status = 'ACTIVE')`);
    params.push(String(req.query.instructor_id));
  }
  if (req.query.instructor_q) {
    conds.push(`EXISTS (SELECT 1 FROM course_instructors ci JOIN instructors i ON i.id = ci.instructor_id WHERE ci.course_id = c.id AND ci.status = 'ACTIVE' AND i.name LIKE ?)`);
    params.push(`%${req.query.instructor_q}%`);
  }
  const rows = all(`SELECT * FROM courses c ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY c.created_at DESC LIMIT 500`, ...params);
  const stats = P.courseStats(rows.map((x) => x.id));
  res.json({ items: rows.map((c) => courseView(c, req.user, stats.get(c.id))) });
});

function courseInput(body, existing) {
  const o = {};
  o.title = body.title !== undefined ? U.requireStr(body.title, '강의명', 200) : existing.title;
  o.cohort_label = body.cohort_label !== undefined ? U.requireStr(body.cohort_label, '기수명', 100) : existing.cohort_label;
  o.description = body.description !== undefined ? U.str(body.description, 5000) : existing?.description;
  o.admin_memo = body.admin_memo !== undefined ? U.str(body.admin_memo, 5000) : existing?.admin_memo;
  o.state = body.state !== undefined ? body.state : (existing.state || 'READY');
  if (!STATES.includes(o.state)) throw E.invalid('운영 상태 값이 올바르지 않습니다.');
  for (const k of ['starts_on', 'ends_on']) {
    o[k] = body[k] !== undefined ? (body[k] || null) : existing?.[k] ?? null;
    if (o[k] && !U.isValidDate(o[k])) throw E.invalid('날짜 형식이 올바르지 않습니다.');
  }
  if (o.starts_on && o.ends_on && o.starts_on > o.ends_on) throw E.invalid('시작일이 종료일보다 늦을 수 없습니다.');
  return o;
}

r.post('/courses', A.requireAdmin, (req, res) => {
  const o = courseInput(req.body, {});
  const ins = Array.isArray(req.body.instructor_ids) ? [...new Set(req.body.instructor_ids)] : [];
  const out = tx(() => {
    if (!req.body.confirm_duplicate && get('SELECT 1 FROM courses WHERE title = ? AND cohort_label = ?', o.title, o.cohort_label)) {
      throw E.conflict('같은 강의명·기수의 강의가 이미 있습니다. 그래도 생성하려면 확인해주세요.', { reason: 'POSSIBLE_DUPLICATE' });
    }
    for (const iid of ins) if (!get('SELECT 1 FROM instructors WHERE id = ?', iid)) throw E.invalid('존재하지 않는 강사가 포함되어 있습니다.');
    if (o.state === 'ACTIVE' && ins.length === 0) throw E.invalid('진행 중으로 전환하려면 강사를 1명 이상 배정해주세요.');
    const id = uuid(); const code = nextCode('CRS'); const t = now();
    run(`INSERT INTO courses(id, code, title, cohort_label, description, state, starts_on, ends_on, admin_memo, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, code, o.title, o.cohort_label, o.description, o.state, o.starts_on, o.ends_on, o.admin_memo, req.user.id, req.user.id, t, t);
    ins.forEach((iid) => run(`INSERT INTO course_instructors(course_id, instructor_id, status, assigned_at) VALUES(?,?,'ACTIVE',?)`, id, iid, t));
    A.audit(req, { courseId: id, targetType: 'COURSE', targetId: id, action: 'COURSE_CREATED', changed: { title: o.title, cohort_label: o.cohort_label } });
    return courseView(get('SELECT * FROM courses WHERE id = ?', id), req.user);
  });
  res.status(201).json(out);
});

r.get('/courses/:id', A.requireStaff, (req, res) => {
  const c = AC.loadCourseForStaff(req.user, req.params.id);
  res.json(courseView(c, req.user, P.courseStats([c.id]).get(c.id)));
});

r.patch('/courses/:id', A.requireAdmin, (req, res) => {
  const out = tx(() => {
    const c = get('SELECT * FROM courses WHERE id = ?', req.params.id);
    if (!c) throw E.notFound();
    if (req.body.version !== undefined && Number(req.body.version) !== c.version) {
      throw E.conflict('다른 변경 내용이 있습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.', { reason: 'VERSION_CONFLICT', latest: courseView(c, req.user) });
    }
    const o = courseInput(req.body, c);
    if (o.state === 'ACTIVE' && c.state !== 'ACTIVE' && instructorsOf(c.id).length === 0) throw E.invalid('진행 중으로 전환하려면 강사를 1명 이상 배정해주세요.');
    const changed = {};
    for (const k of Object.keys(o)) if ((o[k] ?? null) !== (c[k] ?? null)) changed[k] = [c[k], o[k]];
    run(`UPDATE courses SET title=?, cohort_label=?, description=?, state=?, starts_on=?, ends_on=?, admin_memo=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`,
      o.title, o.cohort_label, o.description, o.state, o.starts_on, o.ends_on, o.admin_memo, req.user.id, now(), c.id);
    if (Object.keys(changed).length) A.audit(req, { courseId: c.id, targetType: 'COURSE', targetId: c.id, action: 'COURSE_UPDATED', changed });
    return courseView(get('SELECT * FROM courses WHERE id = ?', c.id), req.user);
  });
  res.json(out);
});

r.put('/courses/:id/instructors/:iid', A.requireAdmin, (req, res) => {
  tx(() => {
    const c = get('SELECT * FROM courses WHERE id = ?', req.params.id);
    const i = get('SELECT * FROM instructors WHERE id = ?', req.params.iid);
    if (!c || !i) throw E.notFound();
    const ex = get('SELECT * FROM course_instructors WHERE course_id = ? AND instructor_id = ?', c.id, i.id);
    if (ex && ex.status === 'ACTIVE') return;
    if (ex) run(`UPDATE course_instructors SET status = 'ACTIVE', assigned_at = ?, removed_at = NULL WHERE course_id = ? AND instructor_id = ?`, now(), c.id, i.id);
    else run(`INSERT INTO course_instructors(course_id, instructor_id, status, assigned_at) VALUES(?,?,'ACTIVE',?)`, c.id, i.id, now());
    A.audit(req, { courseId: c.id, targetType: 'COURSE', targetId: c.id, action: 'INSTRUCTOR_ASSIGNED', changed: { instructor: i.code } });
  });
  res.json({ instructors: instructorsOf(req.params.id) });
});
r.delete('/courses/:id/instructors/:iid', A.requireAdmin, (req, res) => {
  const out = tx(() => {
    const c = get('SELECT * FROM courses WHERE id = ?', req.params.id);
    const i = get('SELECT * FROM instructors WHERE id = ?', req.params.iid);
    if (!c || !i) throw E.notFound();
    run(`UPDATE course_instructors SET status = 'REMOVED', removed_at = ? WHERE course_id = ? AND instructor_id = ? AND status = 'ACTIVE'`, now(), c.id, i.id);
    A.audit(req, { courseId: c.id, targetType: 'COURSE', targetId: c.id, action: 'INSTRUCTOR_REMOVED', changed: { instructor: i.code } });
    const list = instructorsOf(c.id);
    return { instructors: list, no_instructor_warning: c.state === 'ACTIVE' && list.length === 0 };
  });
  res.json(out);
});

// ---------- 수강생 명단 ----------
function enrollmentRow(e, user) {
  const phoneVisible = user.isAdmin;
  return {
    id: e.id, status: e.status, enrolled_at: e.enrolled_at, deactivated_at: e.deactivated_at,
    reason: user.isAdmin ? e.reason : undefined, admin_memo: user.isAdmin ? e.admin_memo : undefined,
    student: { id: e.student_id, code: e.code, name: e.name, status: e.student_status, phone: phoneVisible ? U.formatPhone(e.normalized_phone) : U.maskPhone(e.normalized_phone) },
  };
}
r.get('/courses/:id/enrollments', A.requireStaff, (req, res) => {
  const c = AC.loadCourseForStaff(req.user, req.params.id);
  const { page, size, offset } = U.pageParams(req.query);
  const status = ['ACTIVE', 'INACTIVE', 'ALL'].includes(req.query.status) ? req.query.status : 'ACTIVE';
  const q = U.normalizeName(req.query.q || '');
  const digits = q.replace(/\D/g, '');
  const conds = ['e.course_id = ?']; const params = [c.id];
  if (status !== 'ALL') { conds.push('e.status = ?'); params.push(status); }
  if (q) {
    conds.push(`(s.normalized_name LIKE ? OR s.code LIKE ? ${digits.length >= 4 ? 'OR s.normalized_phone LIKE ?' : ''})`);
    params.push(`%${q}%`, `%${q.toUpperCase()}%`); if (digits.length >= 4) params.push(`%${digits}%`);
  }
  const where = conds.join(' AND ');
  const total = get(`SELECT COUNT(*) n FROM enrollments e JOIN students s ON s.id = e.student_id WHERE ${where}`, ...params).n;
  const rows = all(`SELECT e.*, s.code, s.name, s.normalized_phone, s.status AS student_status FROM enrollments e JOIN students s ON s.id = e.student_id
    WHERE ${where} ORDER BY s.normalized_name, s.code LIMIT ? OFFSET ?`, ...params, size, offset);
  const pubs = P.publishedAssignments(c.id);
  const cells = P.cellMatrix(c.id, rows.map((x) => x.id), pubs);
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

// 7.4 개별 등록·기존 학생 연결 (관리자)
r.post('/courses/:id/enrollments', A.requireAdmin, async (req, res) => {
  const c = get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!c) throw E.notFound();
  const memo = U.str(req.body.memo, 1000);
  let studentId = req.body.student_id || null;
  let name; let phone; let hash = null;
  if (!studentId) {
    name = U.normalizeName(U.str(req.body.name, 50));
    if (!name) throw E.invalid('이름을 입력해주세요.');
    phone = U.normalizePhone(req.body.phone);
    if (!phone) throw E.invalid(U.phoneError(req.body.phone));
    if (!get('SELECT 1 FROM students WHERE normalized_phone = ?', phone)) hash = await A.hashPassword(phone, 'STUDENT');
  }
  const out = tx(() => {
    let s;
    if (studentId) {
      s = get('SELECT * FROM students WHERE id = ?', studentId);
      if (!s) throw E.notFound();
    } else {
      s = get('SELECT * FROM students WHERE normalized_phone = ?', phone);
      if (s && s.normalized_name !== name) throw E.conflict('기존 수강생 정보와 이름이 다릅니다. 확인 후 등록해주세요.', { reason: 'NAME_CONFLICT', existing: { code: s.code, name: s.name } });
    }
    if (s && s.status !== 'ACTIVE') throw E.conflict('비활성화된 수강생입니다. 전체 학생 관리에서 검토 후 활성화해주세요.', { reason: 'STUDENT_INACTIVE' });
    if (s) {
      const ex = get('SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?', c.id, s.id);
      if (ex && ex.status === 'ACTIVE') throw E.conflict('이미 등록된 수강생입니다. 기존 기록을 유지합니다.', { reason: 'ALREADY_ENROLLED' });
      if (ex) throw E.conflict('비활성화된 수강 등록이 있습니다. 재활성화가 필요합니다.', { reason: 'NEEDS_REACTIVATION', enrollment_id: ex.id });
    } else {
      if (!hash) throw E.conflict('잠시 후 다시 시도해주세요.');
      s = createStudent(name, phone, hash);
      A.audit(req, { courseId: c.id, targetType: 'STUDENT', targetId: s.id, action: 'STUDENT_CREATED', changed: { code: s.code } });
    }
    const eid = createEnrollment(req, c.id, s.id, memo, 'MANUAL');
    return { enrollment_id: eid, student: { id: s.id, code: s.code, name: s.name } };
  });
  res.status(201).json(out);
});

function createStudent(name, phone, hash) {
  const id = uuid(); const t = now();
  run(`INSERT INTO students(id, code, name, normalized_name, normalized_phone, status, created_at, updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?)`,
    id, nextCode('STU'), name, name, phone, t, t);
  run('INSERT INTO student_credentials(student_id, password_hash) VALUES(?,?)', id, hash);
  return get('SELECT * FROM students WHERE id = ?', id);
}
function createEnrollment(req, courseId, studentId, memo, source) {
  const id = uuid();
  run(`INSERT INTO enrollments(id, course_id, student_id, status, enrolled_at, admin_memo) VALUES(?,?,?,'ACTIVE',?,?)`, id, courseId, studentId, now(), memo);
  run(`INSERT INTO enrollment_events(enrollment_id, action, actor_id, reason, created_at) VALUES(?,?,?,?,?)`, id, 'ENROLLED', req.user.id, source, now());
  A.audit(req, { courseId, targetType: 'ENROLLMENT', targetId: id, action: 'ENROLLED', changed: { source } });
  return id;
}

// 7.5 수강 등록 비활성화·재활성화
r.patch('/enrollments/:id/status', A.requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw E.invalid('상태 값이 올바르지 않습니다.');
  const reason = (U.str(req.body.reason, 500) || '').trim();
  if (status === 'INACTIVE' && !reason) throw E.invalid('비활성화 사유를 입력해주세요. (환불, 중도탈퇴, 오등록 등)');
  const out = tx(() => {
    const e = get('SELECT * FROM enrollments WHERE id = ?', req.params.id);
    if (!e) throw E.notFound();
    if (e.status === status) return { id: e.id, status };
    if (status === 'INACTIVE') run(`UPDATE enrollments SET status = 'INACTIVE', deactivated_at = ?, reason = ? WHERE id = ?`, now(), reason, e.id);
    else run(`UPDATE enrollments SET status = 'ACTIVE', deactivated_at = NULL, reason = ? WHERE id = ?`, reason || null, e.id);
    run(`INSERT INTO enrollment_events(enrollment_id, action, actor_id, reason, created_at) VALUES(?,?,?,?,?)`, e.id, status === 'ACTIVE' ? 'REACTIVATED' : 'DEACTIVATED', req.user.id, reason, now());
    A.audit(req, { courseId: e.course_id, targetType: 'ENROLLMENT', targetId: e.id, action: status === 'ACTIVE' ? 'ENROLLMENT_REACTIVATED' : 'ENROLLMENT_DEACTIVATED', reason });
    return { id: e.id, status };
  });
  res.json(out);
});
r.patch('/enrollments/:id', A.requireAdmin, (req, res) => {
  const e = get('SELECT * FROM enrollments WHERE id = ?', req.params.id);
  if (!e) throw E.notFound();
  run('UPDATE enrollments SET admin_memo = ? WHERE id = ?', U.str(req.body.admin_memo, 1000), e.id);
  res.json({ ok: true });
});

// 5.3 학생 로그인 정보 확인 (조회 이력 기록)
r.post('/enrollments/:id/login-info/reveal', A.requireStaff, (req, res) => {
  const e = AC.loadEnrollmentForStaff(req.user, req.params.id);
  const s = get('SELECT * FROM students WHERE id = ?', e.student_id);
  if (!req.user.isAdmin && (e.status !== 'ACTIVE' || s.status !== 'ACTIVE')) {
    throw E.forbidden('비활성 수강생의 로그인 정보는 확인할 수 없습니다.');
  }
  A.audit(req, { courseId: e.course_id, targetType: 'STUDENT', targetId: s.id, action: 'LOGIN_INFO_REVEALED', changed: { enrollment_id: e.id }, restricted: true });
  res.json({ code: s.code, login_id: s.name, login_password: s.normalized_phone, phone_display: U.formatPhone(s.normalized_phone) });
});

// ---------- 명단 업로드 (7장) ----------
r.get('/import-template.csv', A.requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('수강생_명단_양식.csv')}`);
  res.send('﻿이름,전화번호,수강 등록 메모\n홍길동,010-1234-5678,\n');
});

function decodeCsv(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  const u = buf.toString('utf8');
  if (!u.includes('�')) return u;
  const k = iconv.decode(buf, 'cp949');
  if (k.includes('�')) throw E.invalid('CSV 인코딩을 해석할 수 없습니다. UTF-8 형식으로 저장한 뒤 다시 업로드해주세요.');
  return k;
}
function readWorkbook(buf, name) {
  if (name.toLowerCase().endsWith('.csv')) return XLSX.read(decodeCsv(buf), { type: 'string', raw: true });
  return XLSX.read(buf, { type: 'buffer', cellDates: false });
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

function classifyJob(job) {
  const rows = all('SELECT * FROM import_rows WHERE import_job_id = ? ORDER BY row_number', job.id);
  const prepared = rows.map((row) => {
    const name = U.normalizeName(row.raw_name);
    const phone = U.normalizePhone(row.raw_phone);
    let cls = null; let error = null;
    if (row.excluded) cls = 'EXCLUDED';
    else if (!name && !String(row.raw_phone || '').trim()) { cls = 'ERROR'; error = '이름과 전화번호가 비어 있습니다.'; }
    else if (!name) { cls = 'ERROR'; error = '이름이 비어 있습니다.'; }
    else if (!phone) { cls = 'ERROR'; error = U.phoneError(row.raw_phone); }
    return { row, name, phone, cls, error };
  });
  const groups = new Map();
  prepared.filter((p) => !p.cls).forEach((p) => { if (!groups.has(p.phone)) groups.set(p.phone, []); groups.get(p.phone).push(p); });
  for (const list of groups.values()) {
    const names = new Set(list.map((p) => p.name));
    if (names.size > 1) list.forEach((p) => { p.cls = 'CONFLICT_IN_FILE'; p.error = '같은 파일 안에 같은 전화번호로 서로 다른 이름이 있습니다.'; });
    else list.slice(1).forEach((p) => { p.cls = 'DUP_IN_FILE'; p.error = `파일 안 중복 행입니다. (${list[0].row.row_number}행만 처리)`; });
  }
  for (const p of prepared) {
    if (p.cls) continue;
    const s = get('SELECT * FROM students WHERE normalized_phone = ?', p.phone);
    if (!s) { p.cls = 'NEW'; continue; }
    if (s.normalized_name !== p.name) { p.cls = 'NAME_CONFLICT'; p.error = `기존 수강생 정보와 이름이 다릅니다. 확인 후 등록해주세요. (기존: ${s.name}, ${s.code})`; continue; }
    if (s.status !== 'ACTIVE') { p.cls = 'STUDENT_INACTIVE'; p.error = '비활성화된 수강생입니다. 관리자 검토가 필요합니다.'; continue; }
    const e = get('SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?', job.course_id, s.id);
    if (!e) { p.cls = 'EXISTING_NEW_ENROLLMENT'; p.student_id = s.id; continue; }
    if (e.status === 'ACTIVE') { p.cls = 'ALREADY_ENROLLED'; p.error = '이미 등록된 수강생입니다. 기존 기록을 유지합니다.'; }
    else { p.cls = 'NEEDS_REACTIVATION'; p.error = '비활성화된 수강 등록입니다. 재활성화가 필요합니다.'; }
    p.student_id = s.id; p.enrollment_id = e.id;
  }
  for (const p of prepared) {
    run(`UPDATE import_rows SET normalized_name = ?, normalized_phone = ?, classification = ?, error = ?, student_id_optional = ?, enrollment_id_optional = ?
      WHERE import_job_id = ? AND row_number = ?`, p.name, p.phone, p.cls, p.error, p.student_id || null, p.enrollment_id || null, job.id, p.row.row_number);
  }
}
const COMMITTABLE = ['NEW', 'EXISTING_NEW_ENROLLMENT'];
function jobView(jobId) {
  const j = get('SELECT j.*, c.code AS course_code, c.title AS course_title, c.cohort_label FROM import_jobs j JOIN courses c ON c.id = j.course_id WHERE j.id = ?', jobId);
  const rows = all('SELECT * FROM import_rows WHERE import_job_id = ? ORDER BY row_number', jobId).map((x) => ({
    row_number: x.row_number, raw_name: x.raw_name, raw_phone: x.raw_phone, memo: x.memo, name: x.normalized_name,
    phone: x.normalized_phone ? U.formatPhone(x.normalized_phone) : null, classification: x.classification, error: x.error,
    excluded: !!x.excluded, result: x.result, result_message: x.result_message,
  }));
  const counts = {};
  rows.forEach((x) => { counts[x.classification] = (counts[x.classification] || 0) + 1; });
  return {
    id: j.id, course_id: j.course_id, course_code: j.course_code, course_title: j.course_title, cohort_label: j.cohort_label,
    state: j.state, original_name: j.original_name, sheet_names: JSON.parse(j.sheet_names || '[]'), sheet_name: j.sheet_name,
    headers: JSON.parse(j.headers || '[]'), mapping: JSON.parse(j.mapping || '{}'), created_at: j.created_at, committed_at: j.committed_at,
    preview_counts: counts, committable: rows.filter((x) => COMMITTABLE.includes(x.classification)).length,
    result_counts: j.counts ? JSON.parse(j.counts) : null, rows,
  };
}
function loadRowsFromWorkbook(job, wb, sheet, mappingIn) {
  const data = sheetRows(wb, sheet);
  const headers = (data[0] || []).map((h) => String(h).trim());
  const mapping = mappingIn && mappingIn.name != null && mappingIn.phone != null ? mappingIn : guessMapping(headers);
  const body = data.slice(1);
  if (body.length > F.LIMITS.rosterRows) throw E.invalid(`명단은 최대 ${F.LIMITS.rosterRows}행까지 업로드할 수 있습니다.`);
  run('DELETE FROM import_rows WHERE import_job_id = ?', job.id);
  run('UPDATE import_jobs SET sheet_name = ?, headers = ?, mapping = ? WHERE id = ?', sheet, JSON.stringify(headers), JSON.stringify(mapping), job.id);
  if (mapping.name == null || mapping.phone == null) return; // 열 매핑 필요
  const cell = (row, i) => (i == null || i === '' ? '' : String(row[Number(i)] ?? '').trim());
  body.forEach((row, idx) => {
    run(`INSERT INTO import_rows(import_job_id, row_number, raw_name, raw_phone, memo, classification) VALUES(?,?,?,?,?,'PENDING')`,
      job.id, idx + 2, cell(row, mapping.name).slice(0, 100), cell(row, mapping.phone).slice(0, 40), cell(row, mapping.memo).slice(0, 1000) || null);
  });
  classifyJob(job);
}
function loadJob(id) {
  const j = get('SELECT * FROM import_jobs WHERE id = ?', id);
  if (!j) throw E.notFound();
  return j;
}

r.post('/courses/:id/imports/preview', A.requireAdmin, F.uploadRoster, (req, res) => {
  const c = get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!c) throw E.notFound();
  F.validate(req.file, F.ROSTER_TYPES, F.LIMITS.rosterBytes);
  let wb;
  try { wb = readWorkbook(req.file.buffer, F.safeName(req.file.originalname)); } catch (e) {
    if (e.status) throw e;
    throw E.invalid('파일을 읽을 수 없습니다. 표준 양식(.xlsx 또는 CSV)을 사용해주세요.');
  }
  const out = tx(() => {
    const f = F.store(req.file, { types: F.ROSTER_TYPES, maxBytes: F.LIMITS.rosterBytes, purpose: 'roster', user: req.user });
    const id = uuid();
    run(`INSERT INTO import_jobs(id, course_id, uploaded_by, state, file_id, file_hash, original_name, sheet_names, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      id, c.id, req.user.id, 'PREVIEW', f.id, crypto.createHash('sha256').update(req.file.buffer).digest('hex'), f.original_name, JSON.stringify(wb.SheetNames), now());
    const job = loadJob(id);
    let mapping = null;
    if (req.body.name_col !== undefined && req.body.phone_col !== undefined) mapping = { name: req.body.name_col, phone: req.body.phone_col, memo: req.body.memo_col ?? null };
    loadRowsFromWorkbook(job, wb, req.body.sheet && wb.SheetNames.includes(req.body.sheet) ? req.body.sheet : wb.SheetNames[0], mapping);
    return jobView(id);
  });
  res.status(201).json(out);
});

r.post('/imports/:id/remap', A.requireAdmin, (req, res) => {
  const out = tx(() => {
    const job = loadJob(req.params.id);
    if (job.state !== 'PREVIEW') throw E.conflict('이미 확정된 업로드입니다.');
    const f = get('SELECT * FROM file_assets WHERE id = ?', job.file_id);
    const wb = readWorkbook(fs.readFileSync(F.objectPath(f)), f.original_name);
    const m = req.body.mapping || {};
    const toIdx = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    loadRowsFromWorkbook(job, wb, req.body.sheet || job.sheet_name, { name: toIdx(m.name), phone: toIdx(m.phone), memo: toIdx(m.memo) });
    return jobView(job.id);
  });
  res.json(out);
});

r.patch('/imports/:id/rows/:n', A.requireAdmin, (req, res) => {
  const out = tx(() => {
    const job = loadJob(req.params.id);
    if (job.state !== 'PREVIEW') throw E.conflict('이미 확정된 업로드입니다.');
    const row = get('SELECT * FROM import_rows WHERE import_job_id = ? AND row_number = ?', job.id, Number(req.params.n));
    if (!row) throw E.notFound();
    run('UPDATE import_rows SET raw_name = ?, raw_phone = ?, memo = ?, excluded = ? WHERE import_job_id = ? AND row_number = ?',
      req.body.name !== undefined ? U.str(req.body.name, 100) : row.raw_name,
      req.body.phone !== undefined ? U.str(req.body.phone, 40) : row.raw_phone,
      req.body.memo !== undefined ? U.str(req.body.memo, 1000) : row.memo,
      req.body.excluded !== undefined ? (req.body.excluded ? 1 : 0) : row.excluded, job.id, row.row_number);
    classifyJob(job);
    return jobView(job.id);
  });
  res.json(out);
});

r.get('/imports/:id', A.requireAdmin, (req, res) => { loadJob(req.params.id); res.json(jobView(req.params.id)); });
r.get('/courses/:id/imports', A.requireAdmin, (req, res) => {
  res.json({ items: all(`SELECT id, state, original_name, counts, created_at, committed_at FROM import_jobs WHERE course_id = ? ORDER BY created_at DESC LIMIT 50`, req.params.id)
    .map((j) => ({ ...j, counts: j.counts ? JSON.parse(j.counts) : null })) });
});

// 확정: 행 단위로 학생·인증·등록을 원자적으로 생성하고, 확정 시점에 재검사한다.
r.post('/imports/:id/commit', A.requireAdmin, (req, res) => {
  const job = tx(() => {
    const j = loadJob(req.params.id);
    if (j.state !== 'PREVIEW') return j; // 멱등: 이미 확정 중/완료면 현재 상태 반환
    classifyJob(j);
    run(`UPDATE import_jobs SET state = 'COMMITTING', idempotency_key = COALESCE(?, idempotency_key) WHERE id = ?`, U.str(req.body.idempotency_key, 100), j.id);
    return loadJob(j.id);
  });
  if (job.state === 'COMMITTING' && !runningCommits.has(job.id)) {
    const p = processCommit(req, job.id).catch((e) => console.error('import commit failed', e));
    runningCommits.set(job.id, p);
    p.finally(() => runningCommits.delete(job.id));
  }
  res.status(202).json(jobView(job.id));
});
const runningCommits = new Map();
r.locals = { runningCommits };

async function processCommit(req, jobId) {
  const job = loadJob(jobId);
  const rows = all('SELECT * FROM import_rows WHERE import_job_id = ? ORDER BY row_number', jobId);
  const hashes = new Map();
  const toHash = rows.filter((x) => x.classification === 'NEW');
  for (let i = 0; i < toHash.length; i += 16) {
    await Promise.all(toHash.slice(i, i + 16).map(async (x) => hashes.set(x.normalized_phone, await A.hashPassword(x.normalized_phone, 'STUDENT'))));
  }
  const counts = { created: 0, linked: 0, skipped: 0, failed: 0 };
  const actorReq = { user: req.user };
  for (const row of rows) {
    let result; let msg = null; let sid = null; let eid = null;
    if (!COMMITTABLE.includes(row.classification)) {
      result = ['ALREADY_ENROLLED', 'DUP_IN_FILE', 'EXCLUDED'].includes(row.classification) ? 'SKIPPED' : 'FAILED';
      msg = row.error || (row.classification === 'EXCLUDED' ? '관리자가 제외한 행입니다.' : null);
    } else {
      try {
        ({ result, msg, sid, eid } = tx(() => {
          // 미리보기 후 다른 관리자가 먼저 등록한 경우 재검사
          let s = get('SELECT * FROM students WHERE normalized_phone = ?', row.normalized_phone);
          if (s && s.normalized_name !== row.normalized_name) return { result: 'FAILED', msg: '기존 수강생 정보와 이름이 다릅니다. 확인 후 등록해주세요.' };
          if (s && s.status !== 'ACTIVE') return { result: 'FAILED', msg: '비활성화된 수강생입니다. 관리자 검토가 필요합니다.' };
          let created = false;
          if (!s) {
            const h = hashes.get(row.normalized_phone);
            if (!h) return { result: 'FAILED', msg: '처리 중 오류가 발생했습니다. 다시 시도해주세요.' };
            s = createStudent(row.normalized_name, row.normalized_phone, h); created = true;
            A.audit(actorReq, { courseId: job.course_id, targetType: 'STUDENT', targetId: s.id, action: 'STUDENT_CREATED', changed: { code: s.code, import_job: jobId } });
          }
          const ex = get('SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?', job.course_id, s.id);
          if (ex) return { result: 'SKIPPED', msg: ex.status === 'ACTIVE' ? '이미 등록된 수강생입니다. 기존 기록을 유지합니다.' : '재활성화가 필요합니다.', sid: s.id, eid: ex.id };
          const e = createEnrollment(actorReq, job.course_id, s.id, row.memo, 'IMPORT');
          return { result: created ? 'CREATED' : 'LINKED', msg: created ? '신규 학생 등록' : '기존 학생 연결', sid: s.id, eid: e };
        }));
      } catch (e) {
        console.error(e);
        result = 'FAILED'; msg = '처리 중 오류가 발생했습니다. 다시 시도해주세요.';
      }
    }
    counts[result.toLowerCase()]++;
    run(`UPDATE import_rows SET result = ?, result_message = ?, student_id_optional = COALESCE(?, student_id_optional), enrollment_id_optional = COALESCE(?, enrollment_id_optional)
      WHERE import_job_id = ? AND row_number = ?`, result, msg, sid, eid, jobId, row.row_number);
    if (rows.length > 200) await new Promise((r2) => setImmediate(r2)); // 다른 요청 처리 양보
  }
  run(`UPDATE import_jobs SET state = 'COMMITTED', counts = ?, committed_at = ? WHERE id = ?`, JSON.stringify(counts), now(), jobId);
  A.audit(actorReq, { courseId: job.course_id, targetType: 'IMPORT', targetId: jobId, action: 'ROSTER_IMPORTED', changed: counts });
}

module.exports = r;
module.exports.instructorsOf = instructorsOf;
module.exports.processCommit = processCommit;
module.exports.runningCommits = runningCommits;
