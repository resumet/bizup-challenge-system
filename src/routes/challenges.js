'use strict';
const express = require('express');
const fs = require('fs');
const { get, all, run, tx, uuid, now } = require('../db');
const U = require('../util');
const { E } = U;
const A = require('../auth');
const P = require('../progress');
const F = require('../files');
const AC = require('../access');

const r = express.Router();
const VERSION_MSG = '다른 변경 내용이 있습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.';
const LOCKED_MSG = '수강생이 시작한 과제입니다. 복사하여 새 과제로 만들어주세요.';

// ---------- 챌린지 ----------
function challengeInput(body, ex = {}) {
  const o = {};
  o.title = body.title !== undefined ? U.requireStr(body.title, '챌린지 제목', 200) : ex.title;
  o.description = body.description !== undefined ? U.str(body.description, 10000) : ex.description ?? null;
  o.start_date = body.start_date !== undefined ? body.start_date : ex.start_date;
  o.end_date = body.end_date !== undefined ? body.end_date : ex.end_date;
  if (!U.isValidDate(o.start_date) || !U.isValidDate(o.end_date)) throw E.invalid('시작일과 종료일을 입력해주세요.');
  if (o.start_date > o.end_date) throw E.invalid('시작일이 종료일보다 늦을 수 없습니다.');
  o.allow_after_deadline = body.allow_after_deadline !== undefined ? (body.allow_after_deadline ? 1 : 0) : (ex.allow_after_deadline ?? 0);
  o.visibility = body.visibility !== undefined ? body.visibility : (ex.visibility || 'DRAFT');
  if (!['DRAFT', 'PUBLISHED'].includes(o.visibility)) throw E.invalid('공개 상태 값이 올바르지 않습니다.');
  o.sort_order = body.sort_order !== undefined ? Number(body.sort_order) || 0 : (ex.sort_order ?? 0);
  o.starts_at = U.kstDateStartUtc(o.start_date);
  o.deadline_at = U.kstDeadlineUtc(o.end_date);
  return o;
}
function assignmentHasHistory(aid) {
  const a = get('SELECT has_feedback_history FROM assignments WHERE id = ?', aid);
  if (a && a.has_feedback_history) return true;
  return !!(get('SELECT 1 FROM task_progress WHERE assignment_id = ? AND started_at IS NOT NULL LIMIT 1', aid)
    || get('SELECT 1 FROM submissions WHERE assignment_id = ? LIMIT 1', aid)
    || get('SELECT 1 FROM feedback WHERE assignment_id = ? LIMIT 1', aid));
}
function challengeHasHistory(cid) {
  return all('SELECT id FROM assignments WHERE challenge_id = ?', cid).some((a) => assignmentHasHistory(a.id));
}
function challengeImpact(ch) {
  return {
    students: get(`SELECT COUNT(*) n FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? AND e.status = 'ACTIVE' AND s.status = 'ACTIVE'`, ch.course_id).n,
    completed: get(`SELECT COUNT(*) n FROM task_progress tp JOIN assignments a ON a.id = tp.assignment_id WHERE a.challenge_id = ? AND tp.is_completed = 1`, ch.id).n,
  };
}

function challengeStats(courseId) {
  const students = get(`SELECT COUNT(*) n FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? AND e.status = 'ACTIVE' AND s.status = 'ACTIVE'`, courseId).n;
  const perEnr = all(`SELECT a.challenge_id, tp.enrollment_id, COUNT(*) n FROM task_progress tp
    JOIN assignments a ON a.id = tp.assignment_id AND a.visibility = 'PUBLISHED'
    JOIN challenges c ON c.id = a.challenge_id AND c.visibility = 'PUBLISHED'
    JOIN enrollments e ON e.id = tp.enrollment_id AND e.status = 'ACTIVE' JOIN students s ON s.id = e.student_id AND s.status = 'ACTIVE'
    WHERE tp.course_id = ? AND tp.is_completed = 1 GROUP BY a.challenge_id, tp.enrollment_id`, courseId);
  const pubs = all(`SELECT a.challenge_id, COUNT(*) n FROM assignments a JOIN challenges c ON c.id = a.challenge_id
    WHERE a.course_id = ? AND a.visibility = 'PUBLISHED' AND c.visibility = 'PUBLISHED' GROUP BY a.challenge_id`, courseId);
  const pubM = new Map(pubs.map((x) => [x.challenge_id, x.n]));
  const out = new Map();
  for (const [cid, n] of pubM) out.set(cid, { published_assignments: n, active_students: students, completed: 0, finishers: 0, target: n * students });
  for (const x of perEnr) {
    const s = out.get(x.challenge_id); if (!s) continue;
    s.completed += x.n; if (x.n === s.published_assignments) s.finishers++;
  }
  for (const s of out.values()) s.rate = U.pct(s.completed, s.target);
  return { out, students };
}

r.get('/courses/:id/challenges', A.requireStaff, (req, res) => {
  const c = AC.loadCourseForStaff(req.user, req.params.id);
  const { out: stats, students } = challengeStats(c.id);
  const chs = all('SELECT * FROM challenges WHERE course_id = ? ORDER BY sort_order, start_date, created_at', c.id);
  const t = U.serverNow().getTime();
  res.json({
    items: chs.map((ch) => ({
      ...ch, allow_after_deadline: !!ch.allow_after_deadline,
      phase: t < Date.parse(ch.starts_at) ? 'UPCOMING' : t < Date.parse(ch.deadline_at) ? 'RUNNING' : 'ENDED',
      stats: stats.get(ch.id) || { published_assignments: 0, active_students: students, completed: 0, finishers: 0, target: 0, rate: null },
      assignments: all(`SELECT a.id, a.title, a.visibility, a.locked_at, a.submission_required, a.sort_order, a.copied_from_id, a.version,
          (SELECT COUNT(*) FROM checklist_items i WHERE i.assignment_id = a.id) AS item_count,
          (SELECT COUNT(*) FROM task_progress tp JOIN enrollments e ON e.id = tp.enrollment_id AND e.status = 'ACTIVE' WHERE tp.assignment_id = a.id AND tp.is_completed = 1) AS completed
        FROM assignments a WHERE a.challenge_id = ? ORDER BY a.sort_order, a.created_at`, ch.id)
        .map((a) => ({ ...a, submission_required: !!a.submission_required })),
    })),
  });
});

r.post('/courses/:id/challenges', A.requireStaff, (req, res) => {
  const c = AC.loadCourseForStaff(req.user, req.params.id);
  const o = challengeInput({ visibility: 'DRAFT', allow_after_deadline: 0, ...req.body });
  const out = tx(() => {
    const id = uuid(); const t = now();
    if (req.body.sort_order === undefined) o.sort_order = (get('SELECT MAX(sort_order) m FROM challenges WHERE course_id = ?', c.id).m ?? -1) + 1;
    run(`INSERT INTO challenges(id, course_id, title, description, start_date, end_date, starts_at, deadline_at, allow_after_deadline, visibility, sort_order, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.id, o.title, o.description, o.start_date, o.end_date, o.starts_at, o.deadline_at,
    o.allow_after_deadline, o.visibility, o.sort_order, req.user.id, req.user.id, t, t);
    A.audit(req, { courseId: c.id, targetType: 'CHALLENGE', targetId: id, action: 'CHALLENGE_CREATED', changed: { title: o.title } });
    return get('SELECT * FROM challenges WHERE id = ?', id);
  });
  res.status(201).json(out);
});

r.patch('/challenges/:id', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const ch = AC.loadChallengeForStaff(req.user, req.params.id);
    if (req.body.version !== undefined && Number(req.body.version) !== ch.version) throw E.conflict(VERSION_MSG, { reason: 'VERSION_CONFLICT', latest: ch });
    const o = challengeInput(req.body, ch);
    const scheduleChanged = o.start_date !== ch.start_date || o.end_date !== ch.end_date || o.allow_after_deadline !== ch.allow_after_deadline;
    const hist = challengeHasHistory(ch.id);
    if (scheduleChanged && hist && !req.body.confirm_schedule_change) {
      throw E.conflict('진행 중인 챌린지의 일정·종료 후 설정을 변경합니다. 영향 범위를 확인해주세요.', { reason: 'CONFIRM_SCHEDULE_CHANGE', impact: challengeImpact(ch) });
    }
    if (ch.visibility === 'PUBLISHED' && o.visibility === 'DRAFT' && hist) {
      throw E.conflict('학생 수행 또는 피드백 이력이 있는 챌린지는 공개를 취소할 수 없습니다.');
    }
    const changed = {};
    for (const k of ['title', 'description', 'start_date', 'end_date', 'allow_after_deadline', 'visibility', 'sort_order']) if (o[k] !== ch[k]) changed[k] = [ch[k], o[k]];
    run(`UPDATE challenges SET title=?, description=?, start_date=?, end_date=?, starts_at=?, deadline_at=?, allow_after_deadline=?, visibility=?, sort_order=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`,
      o.title, o.description, o.start_date, o.end_date, o.starts_at, o.deadline_at, o.allow_after_deadline, o.visibility, o.sort_order, req.user.id, now(), ch.id);
    if (Object.keys(changed).length) A.audit(req, { courseId: ch.course_id, targetType: 'CHALLENGE', targetId: ch.id, action: scheduleChanged ? 'CHALLENGE_SCHEDULE_CHANGED' : 'CHALLENGE_UPDATED', changed });
    return get('SELECT * FROM challenges WHERE id = ?', ch.id);
  });
  res.json(out);
});

r.delete('/challenges/:id', A.requireStaff, (req, res) => {
  tx(() => {
    const ch = AC.loadChallengeForStaff(req.user, req.params.id);
    if (challengeHasHistory(ch.id)) throw E.conflict('학생 수행 또는 피드백 이력이 있는 챌린지는 삭제할 수 없습니다.');
    for (const a of all('SELECT id FROM assignments WHERE challenge_id = ?', ch.id)) deleteAssignmentRows(a.id);
    run('DELETE FROM challenges WHERE id = ?', ch.id);
    A.audit(req, { courseId: ch.course_id, targetType: 'CHALLENGE', targetId: ch.id, action: 'CHALLENGE_DELETED', changed: { title: ch.title } });
  });
  res.json({ ok: true });
});

// ---------- 과제 ----------
function itemsOf(aid) { return all('SELECT id, title, description, sort_order FROM checklist_items WHERE assignment_id = ? ORDER BY sort_order, rowid', aid); }
function resourcesOf(aid) {
  return all(`SELECT r.id, r.type, r.title, r.url_optional AS url, r.file_id_optional AS file_id, r.sort_order, r.created_at,
      f.original_name, f.size, f.content_type FROM assignment_resources r LEFT JOIN file_assets f ON f.id = r.file_id_optional
    WHERE r.assignment_id = ? AND r.removed_at IS NULL ORDER BY r.sort_order, r.created_at`, aid);
}
function assignmentView(a) {
  const ch = get('SELECT id, title, start_date, end_date, visibility, allow_after_deadline, deadline_at, starts_at FROM challenges WHERE id = ?', a.challenge_id);
  const c = get('SELECT id, code, title, cohort_label FROM courses WHERE id = ?', a.course_id);
  const src = a.copied_from_id ? get(`SELECT a.id, a.title, c.code AS course_code, c.title AS course_title, c.cohort_label FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?`, a.copied_from_id) : null;
  const names = (id) => (id ? (get('SELECT name FROM staff_accounts WHERE id = ?', id) || {}).name : null);
  return {
    ...a, submission_required: !!a.submission_required, has_feedback_history: undefined,
    locked: !!a.locked_at, has_history: assignmentHasHistory(a.id), challenge: { ...ch, allow_after_deadline: !!ch.allow_after_deadline }, course: c,
    copied_from: src, created_by_name: names(a.created_by), updated_by_name: names(a.updated_by),
    items: itemsOf(a.id), resources: resourcesOf(a.id),
  };
}
function normItems(items) {
  if (!Array.isArray(items)) throw E.invalid('해야 할 일 목록 형식이 올바르지 않습니다.');
  if (items.length > 100) throw E.invalid('해야 할 일은 최대 100개까지 등록할 수 있습니다.');
  return items.map((x) => ({ id: x.id || null, title: (U.str(x.title, 300) || '').trim(), description: (U.str(x.description, 2000) || '').trim() || null }));
}

r.post('/challenges/:id/assignments', A.requireStaff, (req, res) => {
  const ch = AC.loadChallengeForStaff(req.user, req.params.id);
  const title = U.requireStr(req.body.title, '과제 제목', 200);
  const items = normItems(req.body.items || []);
  if (items.some((x) => !x.title)) throw E.invalid('해야 할 일의 제목을 입력해주세요.');
  const out = tx(() => {
    const id = uuid(); const t = now();
    const so = req.body.sort_order !== undefined ? Number(req.body.sort_order) || 0 : (get('SELECT MAX(sort_order) m FROM assignments WHERE challenge_id = ?', ch.id).m ?? -1) + 1;
    run(`INSERT INTO assignments(id, course_id, challenge_id, title, description, submission_required, visibility, sort_order, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,'DRAFT',?,?,?,?,?)`, id, ch.course_id, ch.id, title, U.str(req.body.description, 20000), req.body.submission_required ? 1 : 0, so, req.user.id, req.user.id, t, t);
    items.forEach((x, i) => run('INSERT INTO checklist_items(id, assignment_id, title, description, sort_order) VALUES(?,?,?,?,?)', uuid(), id, x.title, x.description, i));
    A.audit(req, { courseId: ch.course_id, targetType: 'ASSIGNMENT', targetId: id, action: 'ASSIGNMENT_CREATED', changed: { title } });
    return assignmentView(get('SELECT * FROM assignments WHERE id = ?', id));
  });
  res.status(201).json(out);
});

r.get('/assignments/:id', A.requireStaff, (req, res) => {
  res.json(assignmentView(AC.loadAssignmentForStaff(req.user, req.params.id)));
});

// 9.3 동결·버전 검사 후 수정
r.patch('/assignments/:id', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const a = AC.loadAssignmentForStaff(req.user, req.params.id);
    if (req.body.version === undefined || Number(req.body.version) !== a.version) {
      throw E.conflict(VERSION_MSG, { reason: 'VERSION_CONFLICT', latest: assignmentView(a) });
    }
    const changed = {};
    const title = req.body.title !== undefined ? U.requireStr(req.body.title, '과제 제목', 200) : a.title;
    const description = req.body.description !== undefined ? U.str(req.body.description, 20000) : a.description;
    const sortOrder = req.body.sort_order !== undefined ? Number(req.body.sort_order) || 0 : a.sort_order;
    const subReq = req.body.submission_required !== undefined ? (req.body.submission_required ? 1 : 0) : a.submission_required;
    if (title !== a.title) changed.title = [a.title, title];
    if ((description || null) !== (a.description || null)) changed.description = ['(이전 설명)', '(수정된 설명)'];
    if (sortOrder !== a.sort_order) changed.sort_order = [a.sort_order, sortOrder];
    const current = itemsOf(a.id);
    let itemsChanged = false; let items = null;
    if (req.body.items !== undefined) {
      items = normItems(req.body.items);
      if (items.some((x) => !x.title)) throw E.invalid('해야 할 일의 제목을 입력해주세요.');
      itemsChanged = items.length !== current.length || items.some((x, i) => x.id !== current[i].id || x.title !== current[i].title || (x.description || null) !== (current[i].description || null));
    }
    if (a.locked_at && (itemsChanged || subReq !== a.submission_required)) {
      throw E.conflict(LOCKED_MSG, { reason: 'ASSIGNMENT_LOCKED' });
    }
    if (subReq !== a.submission_required) changed.submission_required = [!!a.submission_required, !!subReq];
    if (itemsChanged) {
      const keep = new Set(items.filter((x) => x.id).map((x) => x.id));
      for (const c of current) if (!keep.has(c.id)) run('DELETE FROM checklist_items WHERE id = ? AND assignment_id = ?', c.id, a.id);
      items.forEach((x, i) => {
        if (x.id && current.some((c) => c.id === x.id)) run('UPDATE checklist_items SET title = ?, description = ?, sort_order = ? WHERE id = ? AND assignment_id = ?', x.title, x.description, i, x.id, a.id);
        else run('INSERT INTO checklist_items(id, assignment_id, title, description, sort_order) VALUES(?,?,?,?,?)', uuid(), a.id, x.title, x.description, i);
      });
      changed.items = [current.map((x) => x.title), items.map((x) => x.title)];
    }
    if (a.visibility === 'PUBLISHED' && itemsChanged && !items.length) throw E.invalid('해야 할 일을 1개 이상 추가해주세요.');
    run(`UPDATE assignments SET title=?, description=?, sort_order=?, submission_required=?, version=version+1, updated_by=?, updated_at=? WHERE id=?`,
      title, description, sortOrder, subReq, req.user.id, now(), a.id);
    if (Object.keys(changed).length) A.audit(req, { courseId: a.course_id, targetType: 'ASSIGNMENT', targetId: a.id, action: a.locked_at ? 'ASSIGNMENT_UPDATED_AFTER_LOCK' : 'ASSIGNMENT_UPDATED', changed });
    return assignmentView(get('SELECT * FROM assignments WHERE id = ?', a.id));
  });
  res.json(out);
});

r.post('/assignments/:id/publish', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const a = AC.loadAssignmentForStaff(req.user, req.params.id);
    if (!a.title.trim()) throw E.invalid('과제 제목을 입력해주세요.');
    if (!itemsOf(a.id).length) throw E.invalid('해야 할 일을 1개 이상 추가해주세요.');
    if (a.visibility === 'PUBLISHED') return assignmentView(a);
    run(`UPDATE assignments SET visibility = 'PUBLISHED', published_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`, now(), req.user.id, now(), a.id);
    A.audit(req, { courseId: a.course_id, targetType: 'ASSIGNMENT', targetId: a.id, action: 'ASSIGNMENT_PUBLISHED' });
    return assignmentView(get('SELECT * FROM assignments WHERE id = ?', a.id));
  });
  res.json(out);
});
r.post('/assignments/:id/unpublish', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const a = AC.loadAssignmentForStaff(req.user, req.params.id);
    if (assignmentHasHistory(a.id)) throw E.conflict('학생 수행 또는 피드백 이력이 있는 과제는 공개를 취소할 수 없습니다.');
    run(`UPDATE assignments SET visibility = 'DRAFT', version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`, req.user.id, now(), a.id);
    A.audit(req, { courseId: a.course_id, targetType: 'ASSIGNMENT', targetId: a.id, action: 'ASSIGNMENT_UNPUBLISHED' });
    return assignmentView(get('SELECT * FROM assignments WHERE id = ?', a.id));
  });
  res.json(out);
});
function deleteAssignmentRows(aid) {
  run('DELETE FROM task_progress WHERE assignment_id = ? AND started_at IS NULL', aid);
  run('DELETE FROM checklist_items WHERE assignment_id = ?', aid);
  run('DELETE FROM assignment_resources WHERE assignment_id = ?', aid);
  run('UPDATE assignments SET copied_from_id = NULL WHERE copied_from_id = ?', aid);
  run('DELETE FROM assignments WHERE id = ?', aid);
}
r.delete('/assignments/:id', A.requireStaff, (req, res) => {
  tx(() => {
    const a = AC.loadAssignmentForStaff(req.user, req.params.id);
    if (assignmentHasHistory(a.id)) throw E.conflict('학생 수행 또는 피드백 이력이 있는 과제는 삭제할 수 없습니다.');
    deleteAssignmentRows(a.id);
    A.audit(req, { courseId: a.course_id, targetType: 'ASSIGNMENT', targetId: a.id, action: 'ASSIGNMENT_DELETED', changed: { title: a.title } });
  });
  res.json({ ok: true });
});

// ---------- 강사 안내 자료 ----------
r.post('/assignments/:id/resources', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const a = AC.loadAssignmentForStaff(req.user, req.params.id);
    const type = req.body.type;
    const list = resourcesOf(a.id);
    let fileId = null; let url = null;
    if (type === 'LINK') {
      url = String(req.body.url || '').trim();
      if (!U.isSafeUrl(url)) throw E.invalid('http:// 또는 https:// 로 시작하는 링크를 입력해주세요.');
      if (list.filter((x) => x.type === 'LINK').length >= F.LIMITS.resourceLinks) throw E.invalid(`안내 링크는 과제당 최대 ${F.LIMITS.resourceLinks}개입니다.`);
    } else if (type === 'FILE') {
      const f = get('SELECT * FROM file_assets WHERE id = ?', req.body.file_id);
      if (!f || f.uploaded_by_type !== 'STAFF' || f.uploaded_by !== req.user.id || f.status !== 'UPLOADED' || f.purpose !== 'resource') throw E.invalid('업로드가 완료된 파일을 선택해주세요.');
      if (list.filter((x) => x.type === 'FILE').length >= F.LIMITS.resourceFiles) throw E.invalid(`안내 파일은 과제당 최대 ${F.LIMITS.resourceFiles}개입니다.`);
      fileId = f.id;
      run(`UPDATE file_assets SET status = 'ATTACHED' WHERE id = ?`, f.id);
    } else throw E.invalid('자료 유형이 올바르지 않습니다.');
    const title = (U.str(req.body.title, 200) || '').trim() || (fileId ? get('SELECT original_name FROM file_assets WHERE id = ?', fileId).original_name : url);
    const id = uuid();
    run(`INSERT INTO assignment_resources(id, assignment_id, type, file_id_optional, url_optional, title, sort_order, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      id, a.id, type, fileId, url, title, list.length, req.user.id, now());
    A.audit(req, { courseId: a.course_id, targetType: 'RESOURCE', targetId: id, action: 'RESOURCE_ADDED', changed: { assignment: a.title, title } });
    return resourcesOf(a.id);
  });
  res.status(201).json({ resources: out });
});
r.patch('/resources/:id', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const rs = get('SELECT * FROM assignment_resources WHERE id = ? AND removed_at IS NULL', req.params.id);
    if (!rs) throw E.notFound();
    const a = AC.loadAssignmentForStaff(req.user, rs.assignment_id);
    const title = U.requireStr(req.body.title, '자료 제목', 200);
    run('UPDATE assignment_resources SET title = ? WHERE id = ?', title, rs.id);
    A.audit(req, { courseId: a.course_id, targetType: 'RESOURCE', targetId: rs.id, action: 'RESOURCE_UPDATED', changed: { title: [rs.title, title] } });
    return resourcesOf(a.id);
  });
  res.json({ resources: out });
});
r.delete('/resources/:id', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const rs = get('SELECT * FROM assignment_resources WHERE id = ? AND removed_at IS NULL', req.params.id);
    if (!rs) throw E.notFound();
    const a = AC.loadAssignmentForStaff(req.user, rs.assignment_id);
    // 파일 객체는 다른 과제(복사본)가 참조할 수 있으므로 물리 삭제하지 않는다.
    run('UPDATE assignment_resources SET removed_at = ? WHERE id = ?', now(), rs.id);
    A.audit(req, { courseId: a.course_id, targetType: 'RESOURCE', targetId: rs.id, action: 'RESOURCE_REMOVED', changed: { title: rs.title } });
    return resourcesOf(a.id);
  });
  res.json({ resources: out });
});

// ---------- 과제 복사 (9.4) ----------
r.get('/copy-targets', A.requireStaff, (req, res) => {
  const courses = req.user.isAdmin
    ? all(`SELECT id, code, title, cohort_label, state FROM courses ORDER BY created_at DESC`)
    : all(`SELECT c.id, c.code, c.title, c.cohort_label, c.state FROM courses c JOIN course_instructors ci ON ci.course_id = c.id
        WHERE ci.instructor_id = ? AND ci.status = 'ACTIVE' ORDER BY c.created_at DESC`, req.user.instructorId || '');
  res.json({ items: courses.map((c) => ({ ...c, challenges: all('SELECT id, title, start_date, end_date, visibility FROM challenges WHERE course_id = ? ORDER BY sort_order, start_date', c.id) })) });
});
r.get('/assignment-library', A.requireStaff, (req, res) => {
  const q = String(req.query.q || '').trim();
  const scope = req.user.isAdmin ? '1=1' : `EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = a.course_id AND ci.instructor_id = ? AND ci.status = 'ACTIVE')`;
  const params = req.user.isAdmin ? [] : [req.user.instructorId || ''];
  res.json({
    items: all(`SELECT a.id, a.title, a.visibility, a.locked_at, a.submission_required, c.code AS course_code, c.title AS course_title, c.cohort_label, ch.title AS challenge_title,
        (SELECT COUNT(*) FROM checklist_items i WHERE i.assignment_id = a.id) AS item_count
      FROM assignments a JOIN courses c ON c.id = a.course_id JOIN challenges ch ON ch.id = a.challenge_id
      WHERE ${scope} AND (? = '' OR a.title LIKE ? OR c.title LIKE ?) ORDER BY a.created_at DESC LIMIT 100`, ...params, q, `%${q}%`, `%${q}%`),
  });
});

r.post('/assignments/:id/copy', A.requireStaff, (req, res) => {
  const out = tx(() => {
    const src = AC.loadAssignmentForStaff(req.user, req.params.id); // 원본 읽기 권한
    const target = AC.loadChallengeForStaff(req.user, req.body.target_challenge_id); // 대상 편집 권한
    const key = U.str(req.body.idempotency_key, 100);
    if (key) {
      const ex = get(`SELECT result_id FROM idempotency_keys WHERE scope = ? AND key = ?`, 'copy:' + req.user.id, key);
      if (ex) return assignmentView(get('SELECT * FROM assignments WHERE id = ?', ex.result_id));
    }
    const resources = resourcesOf(src.id);
    const skip = new Set(Array.isArray(req.body.skip_resource_ids) ? req.body.skip_resource_ids : []);
    const broken = resources.filter((x) => x.type === 'FILE' && !skip.has(x.id)).filter((x) => {
      const f = get('SELECT * FROM file_assets WHERE id = ?', x.file_id);
      try { return !f || f.status === 'DELETED' || !fs.existsSync(F.objectPath(f)); } catch { return true; }
    });
    if (broken.length) throw E.conflict('일부 안내 파일을 복사할 수 없습니다. 해당 파일을 제외하고 다시 시도해주세요.', { reason: 'FILE_COPY_FAILED', resources: broken.map((x) => ({ id: x.id, title: x.title })) });
    const id = uuid(); const t = now();
    const title = (U.str(req.body.title, 200) || '').trim() || `${src.title} (복사)`;
    const so = (get('SELECT MAX(sort_order) m FROM assignments WHERE challenge_id = ?', target.id).m ?? -1) + 1;
    run(`INSERT INTO assignments(id, course_id, challenge_id, title, description, submission_required, visibility, sort_order, copied_from_id, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?)`, id, target.course_id, target.id, title, src.description, src.submission_required, so, src.id, req.user.id, req.user.id, t, t);
    itemsOf(src.id).forEach((x, i) => run('INSERT INTO checklist_items(id, assignment_id, title, description, sort_order) VALUES(?,?,?,?,?)', uuid(), id, x.title, x.description, i));
    resources.filter((x) => !skip.has(x.id)).forEach((x, i) => run(`INSERT INTO assignment_resources(id, assignment_id, type, file_id_optional, url_optional, title, sort_order, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, uuid(), id, x.type, x.file_id, x.url, x.title, i, req.user.id, t));
    if (key) run('INSERT INTO idempotency_keys(scope, key, result_id, created_at) VALUES(?,?,?,?)', 'copy:' + req.user.id, key, id, t);
    A.audit(req, { courseId: target.course_id, targetType: 'ASSIGNMENT', targetId: id, action: 'ASSIGNMENT_COPIED', changed: { source_id: src.id, source_title: src.title } });
    return assignmentView(get('SELECT * FROM assignments WHERE id = ?', id));
  });
  res.status(201).json(out);
});

module.exports = r;
module.exports.assignmentHasHistory = assignmentHasHistory;
