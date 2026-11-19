'use strict';
const express = require('express');
const { get, all, run, tx, uuid, now } = require('../db');
const U = require('../util');
const { E } = U;
const A = require('../auth');
const P = require('../progress');
const AC = require('../access');

const r = express.Router();

// 13.4 학생 × 과제 매트릭스
r.get('/courses/:id/progress', A.requireStaff, async (req, res) => {
  const c = await AC.loadCourseForStaff(req.user, req.params.id);
  const { page, size, offset } = U.pageParams(req.query);
  const challengeId = req.query.challenge_id || null;
  const assignments = await P.publishedAssignments(c.id, challengeId);
  const status = ['ACTIVE', 'INACTIVE', 'ALL'].includes(req.query.status) ? req.query.status : 'ACTIVE';
  const q = U.normalizeName(req.query.q || '');
  const digits = q.replace(/\D/g, '');
  const conds = ['e.course_id = ?']; const params = [c.id];
  if (status === 'ACTIVE') conds.push(`e.status = 'ACTIVE' AND s.status = 'ACTIVE'`);
  else if (status === 'INACTIVE') conds.push(`(e.status = 'INACTIVE' OR s.status != 'ACTIVE')`);
  if (q) {
    conds.push(`(s.normalized_name ILIKE ? OR s.code ILIKE ? ${digits.length >= 4 ? 'OR s.normalized_phone LIKE ?' : ''})`);
    params.push(`%${q}%`, `%${q}%`); if (digits.length >= 4) params.push(`%${digits}%`);
  }
  const enr = await all(`SELECT e.id, e.status, s.id AS student_id, s.code, s.name, s.normalized_phone, s.status AS student_status
    FROM enrollments e JOIN students s ON s.id = e.student_id WHERE ${conds.join(' AND ')} ORDER BY s.normalized_name, s.code`, ...params);
  const cells = await P.cellMatrix(c.id, enr.map((x) => x.id), assignments);
  let rows = enr.map((e) => {
    const cs = assignments.map((a) => cells.get(e.id + '|' + a.id));
    const done = cs.filter((x) => x.completed).length;
    return {
      enrollment_id: e.id, enrollment_status: e.status,
      student: { id: e.student_id, code: e.code, name: e.name, status: e.student_status, phone: req.user.isAdmin ? U.formatPhone(e.normalized_phone) : U.maskPhone(e.normalized_phone) },
      cells: cs.map((x) => ({ status: x.status, checked: x.checked, items: x.items, subs: x.subs, unread_feedback: x.unread_feedback })),
      completed: done, total: assignments.length, rate: U.pct(done, assignments.length),
      unread_feedback: cs.reduce((s, x) => s + x.unread_feedback, 0),
      has_not_started: cs.some((x) => x.status === 'NOT_STARTED'), has_need_submission: cs.some((x) => x.status === 'NEED_SUBMISSION'),
      has_late: cs.some((x) => x.status === 'COMPLETED_LATE'),
      all_not_started: cs.length > 0 && cs.every((x) => x.status === 'NOT_STARTED'),
    };
  });
  const f = req.query.filter;
  if (f === 'NOT_STARTED') rows = rows.filter((x) => x.all_not_started);
  else if (f === 'HAS_NOT_STARTED') rows = rows.filter((x) => x.has_not_started);
  else if (f === 'NEED_SUBMISSION') rows = rows.filter((x) => x.has_need_submission);
  else if (f === 'COMPLETED') rows = rows.filter((x) => x.total > 0 && x.completed === x.total);
  else if (f === 'INCOMPLETE') rows = rows.filter((x) => x.completed < x.total);
  else if (f === 'LATE') rows = rows.filter((x) => x.has_late);
  else if (f === 'UNREAD_FEEDBACK') rows = rows.filter((x) => x.unread_feedback > 0);
  // 집계(활성 등록 기준)
  const activeRows = rows.filter((x) => x.enrollment_status === 'ACTIVE' && x.student.status === 'ACTIVE');
  const completed = activeRows.reduce((s, x) => s + x.completed, 0);
  const target = activeRows.length * assignments.length;
  res.json({
    assignments: assignments.map((a) => ({ id: a.id, title: a.title, challenge_id: a.challenge_id, challenge_title: a.challenge_title, submission_required: !!a.submission_required, item_count: a.item_count })),
    summary: { students: activeRows.length, assignments: assignments.length, completed, target, rate: U.pct(completed, target) },
    rows: rows.slice(offset, offset + size), total: rows.length, page, size,
  });
});

async function submissionsFor(enrollmentId, assignmentId) {
  const subs = await all(`SELECT * FROM submissions WHERE enrollment_id = ? AND assignment_id = ? ORDER BY submitted_at`, enrollmentId, assignmentId);
  return Promise.all(subs.map(async (s) => ({
    id: s.id, type: s.type, status: s.status, current_revision: s.current_revision, submitted_at: s.submitted_at, removed_at: s.removed_at,
    versions: await all(`SELECT v.revision, v.type, v.url_optional AS url, v.file_id_optional AS file_id, v.created_at, f.original_name, f.size, f.status AS file_status
      FROM submission_versions v LEFT JOIN file_assets f ON f.id = v.file_id_optional WHERE v.submission_id = ? ORDER BY v.revision DESC`, s.id),
  })));
}
async function feedbackFor(enrollmentId, assignmentId, studentId, { includeDeleted = false } = {}) {
  const rows = await all(`SELECT f.*, a.name AS author_name, r.last_read_version, r.read_at,
      (SELECT COUNT(*) FROM feedback_history h WHERE h.feedback_id = f.id) AS history_count
    FROM feedback f JOIN staff_accounts a ON a.id = f.author_staff_id
    LEFT JOIN feedback_reads r ON r.feedback_id = f.id AND r.student_id = ?
    WHERE f.enrollment_id = ? AND f.assignment_id = ? ${includeDeleted ? '' : 'AND f.deleted_at IS NULL'} ORDER BY f.created_at`, studentId, enrollmentId, assignmentId);
  return Promise.all(rows.map(async (f) => ({
    id: f.id, body: f.deleted_at ? null : f.body, author_staff_id: f.author_staff_id, author_name: f.author_name, version: f.version,
    created_at: f.created_at, updated_at: f.updated_at, deleted_at: f.deleted_at,
    read: f.last_read_version != null && f.last_read_version >= f.version, read_at: f.read_at,
    submission_refs: await all('SELECT submission_id, submission_revision FROM feedback_submission_refs WHERE feedback_id = ?', f.id),
    history_count: f.history_count,
  })));
}

// 학생 상세 (강의 범위)
r.get('/enrollments/:id/detail', A.requireStaff, async (req, res) => {
  const e = await AC.loadEnrollmentForStaff(req.user, req.params.id);
  const s = await get('SELECT * FROM students WHERE id = ?', e.student_id);
  const c = await get('SELECT id, code, title, cohort_label, state FROM courses WHERE id = ?', e.course_id);
  // 다른 수강 이력: 관리자는 전체, 강사는 자신이 배정된 강의만
  const others = await all(`SELECT e2.id, e2.status, c2.id AS course_id, c2.code, c2.title, c2.cohort_label FROM enrollments e2 JOIN courses c2 ON c2.id = e2.course_id
    WHERE e2.student_id = ? AND e2.id != ? ${req.user.isAdmin ? '' : `AND EXISTS (SELECT 1 FROM course_instructors ci WHERE ci.course_id = c2.id AND ci.instructor_id = ? AND ci.status = 'ACTIVE')`}`,
  s.id, e.id, ...(req.user.isAdmin ? [] : [req.user.instructorId]));
  const assignments = await P.publishedAssignments(c.id);
  const cells = await P.cellMatrix(c.id, [e.id], assignments);
  const tasks = await Promise.all(assignments.map(async (a) => {
    const tp = await get('SELECT * FROM task_progress WHERE enrollment_id = ? AND assignment_id = ?', e.id, a.id);
    const items = (await all(`SELECT i.id, i.title, i.description, ip.is_checked, ip.checked_at FROM checklist_items i
      LEFT JOIN item_progress ip ON ip.checklist_item_id = i.id AND ip.task_progress_id = ? WHERE i.assignment_id = ? ORDER BY i.sort_order`, tp ? tp.id : '', a.id))
      .map((x) => ({ ...x, is_checked: !!x.is_checked }));
    const cell = cells.get(e.id + '|' + a.id);
    return {
      id: a.id, title: a.title, challenge_id: a.challenge_id, challenge_title: a.challenge_title, submission_required: !!a.submission_required,
      status: cell.status, checked: cell.checked, item_count: cell.items, subs: cell.subs,
      completed_at: tp ? tp.completed_at : null, completion_timing: tp ? tp.completion_timing : null, started_at: tp ? tp.started_at : null,
      items, submissions: await submissionsFor(e.id, a.id), feedback: await feedbackFor(e.id, a.id, s.id, { includeDeleted: req.user.isAdmin }),
      events: tp ? await all('SELECT event_type, occurred_at, item_id_optional, submission_id_optional FROM progress_events WHERE task_progress_id = ? ORDER BY id DESC LIMIT 50', tp.id) : [],
    };
  }));
  res.json({
    enrollment: { id: e.id, status: e.status, enrolled_at: e.enrolled_at, deactivated_at: e.deactivated_at, reason: e.reason, admin_memo: req.user.isAdmin ? e.admin_memo : undefined },
    student: { id: s.id, code: s.code, name: s.name, status: s.status, phone: req.user.isAdmin ? U.formatPhone(s.normalized_phone) : U.maskPhone(s.normalized_phone) },
    can_reveal_login: req.user.isAdmin || (e.status === 'ACTIVE' && s.status === 'ACTIVE'),
    course: c, other_enrollments: others, tasks,
  });
});

// ---------- 피드백 (12장) ----------
r.post('/enrollments/:id/assignments/:aid/feedback', A.requireStaff, async (req, res) => {
  const body = U.requireStr(req.body.body, '피드백 내용', 10000);
  const out = await tx(async () => {
    const e = await AC.loadEnrollmentForStaff(req.user, req.params.id);
    const a = await get('SELECT * FROM assignments WHERE id = ? AND course_id = ? FOR UPDATE', req.params.aid, e.course_id);
    if (!a) throw E.notFound();
    const id = uuid(); const t = now();
    await run(`INSERT INTO feedback(id, course_id, enrollment_id, assignment_id, author_staff_id, body, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      id, e.course_id, e.id, a.id, req.user.id, body, t, t);
    await run(`INSERT INTO feedback_history(feedback_id, version, action, body, actor_id, created_at) VALUES(?,?,?,?,?,?)`, id, 1, 'CREATED', body, req.user.id, t);
    // 피드백 당시 현재 제출 버전을 참조로 남긴다.
    for (const s of await all(`SELECT id, current_revision FROM submissions WHERE enrollment_id = ? AND assignment_id = ? AND status = 'READY'`, e.id, a.id)) {
      await run('INSERT INTO feedback_submission_refs(feedback_id, submission_id, submission_revision) VALUES(?,?,?)', id, s.id, s.current_revision);
    }
    await run('UPDATE assignments SET has_feedback_history = 1 WHERE id = ?', a.id);
    await A.audit(req, { courseId: e.course_id, targetType: 'FEEDBACK', targetId: id, action: 'FEEDBACK_CREATED', changed: { assignment: a.title, enrollment_id: e.id } });
    return { id };
  });
  res.status(201).json(out);
});
async function loadFeedbackForEdit(user, id) {
  const f = await get('SELECT * FROM feedback WHERE id = ? AND deleted_at IS NULL FOR UPDATE', id);
  if (!f || !(await AC.canManageCourse(user, f.course_id))) throw E.notFound();
  if (!user.isAdmin && f.author_staff_id !== user.id) throw E.forbidden('본인이 작성한 피드백만 수정·삭제할 수 있습니다.');
  return f;
}
r.patch('/feedback/:id', A.requireStaff, async (req, res) => {
  const body = U.requireStr(req.body.body, '피드백 내용', 10000);
  const out = await tx(async () => {
    const f = await loadFeedbackForEdit(req.user, req.params.id);
    if (Number(req.body.version) !== f.version) throw E.conflict('다른 변경 내용이 있습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.', { reason: 'VERSION_CONFLICT' });
    const t = now();
    await run('UPDATE feedback SET body = ?, version = version + 1, updated_at = ? WHERE id = ?', body, t, f.id);
    await run(`INSERT INTO feedback_history(feedback_id, version, action, body, actor_id, created_at) VALUES(?,?,?,?,?,?)`, f.id, f.version + 1, 'UPDATED', body, req.user.id, t);
    await A.audit(req, { courseId: f.course_id, targetType: 'FEEDBACK', targetId: f.id, action: 'FEEDBACK_UPDATED' });
    return { id: f.id, version: f.version + 1 };
  });
  res.json(out);
});
r.delete('/feedback/:id', A.requireStaff, async (req, res) => {
  await tx(async () => {
    const f = await loadFeedbackForEdit(req.user, req.params.id);
    const t = now();
    await run('UPDATE feedback SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ?', t, t, f.id);
    await run(`INSERT INTO feedback_history(feedback_id, version, action, body, actor_id, created_at) VALUES(?,?,?,?,?,?)`, f.id, f.version + 1, 'DELETED', null, req.user.id, t);
    await A.audit(req, { courseId: f.course_id, targetType: 'FEEDBACK', targetId: f.id, action: 'FEEDBACK_DELETED' });
  });
  res.json({ ok: true });
});
r.get('/feedback/:id/history', A.requireStaff, async (req, res) => {
  const f = await get('SELECT * FROM feedback WHERE id = ?', req.params.id);
  if (!f || !(await AC.canManageCourse(req.user, f.course_id))) throw E.notFound();
  res.json({ items: await all(`SELECT h.version, h.action, h.body, h.created_at, a.name AS actor_name FROM feedback_history h JOIN staff_accounts a ON a.id = h.actor_id WHERE h.feedback_id = ? ORDER BY h.id`, f.id) });
});

module.exports = r;
