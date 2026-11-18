'use strict';
const express = require('express');
const { get, all, run, tx, uuid, now } = require('../db');
const U = require('../util');
const { E } = U;
const A = require('../auth');
const P = require('../progress');
const F = require('../files');
const AC = require('../access');
const { instructorsOf } = require('./courses');

const r = express.Router();
r.use(A.requireStudent);

const NO_ACCESS = '이 강의에 접근할 수 없습니다. 운영자에게 문의해주세요.';

r.get('/profile', (req, res) => {
  const s = get('SELECT code, name, normalized_phone FROM students WHERE id = ?', req.user.id);
  res.json({ code: s.code, name: s.name, phone: U.formatPhone(s.normalized_phone) });
});

function unreadCount(studentId, courseId, assignmentId = null) {
  return get(`SELECT COUNT(*) n FROM feedback f JOIN enrollments e ON e.id = f.enrollment_id AND e.student_id = ? AND e.status = 'ACTIVE'
    JOIN assignments a ON a.id = f.assignment_id AND a.visibility = 'PUBLISHED' JOIN challenges c ON c.id = a.challenge_id AND c.visibility = 'PUBLISHED'
    LEFT JOIN feedback_reads r ON r.feedback_id = f.id AND r.student_id = e.student_id
    WHERE f.course_id = ? AND (? IS NULL OR f.assignment_id = ?) AND f.deleted_at IS NULL AND (r.last_read_version IS NULL OR r.last_read_version < f.version)`,
  studentId, courseId, assignmentId, assignmentId).n;
}
function phaseOf(ch) {
  const t = U.serverNow().getTime();
  return t < Date.parse(ch.starts_at) ? 'UPCOMING' : t < Date.parse(ch.deadline_at) ? 'RUNNING' : 'ENDED';
}

r.get('/courses', (req, res) => {
  const enr = all(`SELECT e.id AS enrollment_id, c.* FROM enrollments e JOIN courses c ON c.id = e.course_id
    WHERE e.student_id = ? AND e.status = 'ACTIVE' ORDER BY c.state = 'ARCHIVED', c.created_at DESC`, req.user.id);
  res.json({
    items: enr.map((c) => {
      const pubs = P.publishedAssignments(c.id);
      const cells = P.cellMatrix(c.id, [c.enrollment_id], pubs);
      const done = pubs.filter((a) => cells.get(c.enrollment_id + '|' + a.id).completed).length;
      const chs = all(`SELECT id, title, start_date, end_date, starts_at, deadline_at FROM challenges WHERE course_id = ? AND visibility = 'PUBLISHED' ORDER BY sort_order, start_date`, c.id);
      return {
        id: c.id, code: c.code, title: c.title, cohort_label: c.cohort_label, state: c.state,
        instructors: instructorsOf(c.id).map((i) => ({ name: i.name })),
        completed: done, total: pubs.length, rate: U.pct(done, pubs.length),
        running_challenges: chs.filter((x) => phaseOf(x) === 'RUNNING').map((x) => ({ id: x.id, title: x.title, end_date: x.end_date })),
        unread_feedback: unreadCount(req.user.id, c.id),
      };
    }),
  });
});

function courseDetail(req, courseId) {
  const enr = AC.activeEnrollment(req.user, courseId);
  if (!enr) throw E.notFound(NO_ACCESS);
  const c = get('SELECT * FROM courses WHERE id = ?', courseId);
  const pubs = P.publishedAssignments(c.id);
  const cells = P.cellMatrix(c.id, [enr.id], pubs);
  const chs = all(`SELECT * FROM challenges WHERE course_id = ? AND visibility = 'PUBLISHED' ORDER BY sort_order, start_date, created_at`, c.id);
  const challenges = chs.map((ch) => {
    const as = pubs.filter((a) => a.challenge_id === ch.id).map((a) => {
      const cell = cells.get(enr.id + '|' + a.id);
      return { id: a.id, title: a.title, submission_required: !!a.submission_required, status: cell.status, status_label: P.STATUS_LABEL[cell.status], checked: cell.checked, item_count: cell.items, subs: cell.subs, unread_feedback: cell.unread_feedback };
    });
    const st = P.actionState(ch, { visibility: 'PUBLISHED' }, enr);
    const done = as.filter((a) => a.status.startsWith('COMPLETED')).length;
    return {
      id: ch.id, title: ch.title, description: ch.description, start_date: ch.start_date, end_date: ch.end_date, allow_after_deadline: !!ch.allow_after_deadline,
      phase: phaseOf(ch), can_act: st.canAct, notice: st.message, assignments: as, completed: done, total: as.length, rate: U.pct(done, as.length),
    };
  });
  const done = pubs.filter((a) => cells.get(enr.id + '|' + a.id).completed).length;
  return {
    id: c.id, code: c.code, title: c.title, cohort_label: c.cohort_label, description: c.description, state: c.state, starts_on: c.starts_on, ends_on: c.ends_on,
    instructors: instructorsOf(c.id).map((i) => ({ name: i.name })), completed: done, total: pubs.length, rate: U.pct(done, pubs.length),
    unread_feedback: unreadCount(req.user.id, c.id), challenges,
  };
}
r.get('/courses/:courseId', (req, res) => res.json(courseDetail(req, req.params.courseId)));
r.get('/courses/:courseId/challenges', (req, res) => res.json({ items: courseDetail(req, req.params.courseId).challenges }));

function assignmentDetail(req, aid) {
  const { assignment: a, enrollment: e } = AC.loadAssignmentForStudent(req.user, aid);
  const ch = get('SELECT * FROM challenges WHERE id = ?', a.challenge_id);
  const c = get('SELECT id, code, title, cohort_label FROM courses WHERE id = ?', a.course_id);
  const tp = get('SELECT * FROM task_progress WHERE enrollment_id = ? AND assignment_id = ?', e.id, a.id);
  const items = all(`SELECT i.id, i.title, i.description, COALESCE(ip.is_checked, 0) AS is_checked FROM checklist_items i
    LEFT JOIN item_progress ip ON ip.checklist_item_id = i.id AND ip.task_progress_id = ? WHERE i.assignment_id = ? ORDER BY i.sort_order`, tp ? tp.id : '', a.id)
    .map((x) => ({ ...x, is_checked: !!x.is_checked }));
  const resources = all(`SELECT r.id, r.type, r.title, r.url_optional AS url, r.file_id_optional AS file_id, f.original_name, f.size, f.content_type
    FROM assignment_resources r LEFT JOIN file_assets f ON f.id = r.file_id_optional WHERE r.assignment_id = ? AND r.removed_at IS NULL ORDER BY r.sort_order, r.created_at`, a.id);
  const submissions = all(`SELECT s.id, s.type, s.current_revision, s.submitted_at, v.url_optional AS url, v.file_id_optional AS file_id, v.created_at AS revised_at,
      f.original_name, f.size, f.content_type FROM submissions s
    JOIN submission_versions v ON v.submission_id = s.id AND v.revision = s.current_revision LEFT JOIN file_assets f ON f.id = v.file_id_optional
    WHERE s.enrollment_id = ? AND s.assignment_id = ? AND s.status = 'READY' ORDER BY s.submitted_at`, e.id, a.id);
  const subMap = new Map(submissions.map((s) => [s.id, s]));
  const feedback = all(`SELECT f.id, f.body, f.version, f.created_at, f.updated_at, s.name AS author_name, r.last_read_version FROM feedback f
    JOIN staff_accounts s ON s.id = f.author_staff_id LEFT JOIN feedback_reads r ON r.feedback_id = f.id AND r.student_id = ?
    WHERE f.enrollment_id = ? AND f.assignment_id = ? AND f.deleted_at IS NULL ORDER BY f.created_at`, req.user.id, e.id, a.id)
    .map((f) => {
      const refs = all('SELECT submission_id, submission_revision FROM feedback_submission_refs WHERE feedback_id = ?', f.id);
      return {
        id: f.id, body: f.body, version: f.version, created_at: f.created_at, updated_at: f.updated_at, author_name: f.author_name,
        is_new: f.last_read_version == null || f.last_read_version < f.version, edited: f.version > 1,
        refs: refs.map((x) => {
          const cur = subMap.get(x.submission_id);
          const v = get(`SELECT v.type, v.url_optional AS url, f2.original_name FROM submission_versions v LEFT JOIN file_assets f2 ON f2.id = v.file_id_optional WHERE v.submission_id = ? AND v.revision = ?`, x.submission_id, x.submission_revision);
          return { label: v ? (v.type === 'LINK' ? v.url : v.original_name) : '', revision: x.submission_revision, state: !cur ? 'REMOVED' : cur.current_revision === x.submission_revision ? 'CURRENT' : 'CHANGED' };
        }),
      };
    });
  const st = P.actionState(ch, a, e);
  const checked = items.filter((x) => x.is_checked).length;
  const status = P.statusOf({ started: !!(tp && tp.started_at), completed: !!(tp && tp.is_completed), timing: tp && tp.completion_timing, items: items.length, checked, subs: submissions.length, required: !!a.submission_required });
  let hint = null;
  if (status === 'NEED_SUBMISSION') hint = '할 일은 모두 완료했습니다. 파일 또는 링크를 제출하면 과제가 완료됩니다.';
  return {
    id: a.id, title: a.title, description: a.description, submission_required: !!a.submission_required,
    course: c, challenge: { id: ch.id, title: ch.title, start_date: ch.start_date, end_date: ch.end_date, allow_after_deadline: !!ch.allow_after_deadline, phase: phaseOf(ch) },
    can_act: st.canAct, notice: st.message, notice_code: st.code,
    items, checked, item_count: items.length, resources, submissions,
    status, status_label: P.STATUS_LABEL[status], hint,
    completed_at: tp ? tp.completed_at : null, completion_timing: tp ? tp.completion_timing : null,
    limits: { files: F.LIMITS.submissionFiles, links: F.LIMITS.submissionLinks, max_mb: F.LIMITS.attachmentBytes / 1048576, extensions: Object.keys(F.ATTACHMENT_TYPES) },
    feedback,
  };
}
r.get('/assignments/:id', (req, res) => res.json(assignmentDetail(req, req.params.id)));

function loadForAction(req, aid) {
  const { assignment: a, enrollment: e } = AC.loadAssignmentForStudent(req.user, aid);
  const ch = get('SELECT * FROM challenges WHERE id = ?', a.challenge_id);
  P.assertCanAct(ch, a, e);
  return { a, e, ch };
}

// 체크: 반전이 아닌 명시적 상태 저장(멱등)
r.put('/assignments/:id/items/:itemId', (req, res) => {
  if (typeof req.body.is_checked !== 'boolean') throw E.invalid('체크 상태 값이 올바르지 않습니다.');
  const want = req.body.is_checked;
  tx(() => {
    const { a, e } = loadForAction(req, req.params.id);
    const item = get('SELECT * FROM checklist_items WHERE id = ? AND assignment_id = ?', req.params.itemId, a.id);
    if (!item) throw E.notFound();
    let tp = get('SELECT * FROM task_progress WHERE enrollment_id = ? AND assignment_id = ?', e.id, a.id);
    if (!tp && !want) return;
    tp = tp || P.ensureTaskProgress(e, a);
    const ip = get('SELECT * FROM item_progress WHERE task_progress_id = ? AND checklist_item_id = ?', tp.id, item.id);
    const cur = !!(ip && ip.is_checked);
    if (cur === want) return;
    const t = U.serverNow().toISOString();
    if (ip) run('UPDATE item_progress SET is_checked = ?, checked_at = ? WHERE task_progress_id = ? AND checklist_item_id = ?', want ? 1 : 0, want ? t : null, tp.id, item.id);
    else run('INSERT INTO item_progress(task_progress_id, assignment_id, checklist_item_id, is_checked, checked_at) VALUES(?,?,?,?,?)', tp.id, a.id, item.id, 1, t);
    if (want) P.markStarted(tp, a, t);
    run('INSERT INTO progress_events(task_progress_id, event_type, item_id_optional, occurred_at) VALUES(?,?,?,?)', tp.id, want ? 'CHECKED' : 'UNCHECKED', item.id, t);
    P.recompute(tp.id);
  });
  res.json(assignmentDetail(req, req.params.id));
});

function countCurrent(e, a, type) {
  return get(`SELECT COUNT(*) n FROM submissions WHERE enrollment_id = ? AND assignment_id = ? AND status = 'READY' AND type = ?`, e.id, a.id, type).n;
}
function takeFile(req, fileId) {
  const f = get('SELECT * FROM file_assets WHERE id = ?', fileId);
  if (!f || f.uploaded_by_type !== 'STUDENT' || f.uploaded_by !== req.user.id || f.status !== 'UPLOADED' || f.purpose !== 'submission') {
    throw E.invalid('파일이 등록되지 않았습니다. 다시 시도해주세요.');
  }
  run(`UPDATE file_assets SET status = 'ATTACHED' WHERE id = ?`, f.id);
  return f.id;
}

r.post('/assignments/:id/submissions', (req, res) => {
  const type = req.body.type;
  const key = U.str(req.body.idempotency_key, 100);
  tx(() => {
    const { a, e } = loadForAction(req, req.params.id); // 최종 확정 단계에서 마감·등록 상태 재검사
    if (key && get('SELECT 1 FROM submissions WHERE enrollment_id = ? AND idempotency_key = ?', e.id, key)) return;
    let url = null; let fileId = null;
    if (type === 'LINK') {
      url = String(req.body.url || '').trim();
      if (!U.isSafeUrl(url)) throw E.invalid('http:// 또는 https:// 로 시작하는 링크를 입력해주세요.');
      if (countCurrent(e, a, 'LINK') >= F.LIMITS.submissionLinks) throw E.invalid(`링크는 최대 ${F.LIMITS.submissionLinks}개까지 제출할 수 있습니다.`);
    } else if (type === 'FILE') {
      if (countCurrent(e, a, 'FILE') >= F.LIMITS.submissionFiles) throw E.invalid(`파일은 최대 ${F.LIMITS.submissionFiles}개까지 제출할 수 있습니다.`);
      fileId = takeFile(req, req.body.file_id);
    } else throw E.invalid('제출 유형이 올바르지 않습니다.');
    const t = U.serverNow().toISOString(); const id = uuid();
    run(`INSERT INTO submissions(id, course_id, enrollment_id, assignment_id, type, current_revision, status, submitted_at, idempotency_key) VALUES(?,?,?,?,?,1,'READY',?,?)`,
      id, a.course_id, e.id, a.id, type, t, key);
    run(`INSERT INTO submission_versions(submission_id, revision, type, file_id_optional, url_optional, created_at, created_by) VALUES(?,?,?,?,?,?,?)`, id, 1, type, fileId, url, t, req.user.id);
    const tp = P.ensureTaskProgress(e, a);
    P.markStarted(tp, a, t);
    run('INSERT INTO progress_events(task_progress_id, event_type, submission_id_optional, occurred_at) VALUES(?,?,?,?)', tp.id, 'SUBMITTED', id, t);
    P.recompute(tp.id);
  });
  res.status(201).json(assignmentDetail(req, req.params.id));
});

function loadOwnSubmission(req, id) {
  const s = get(`SELECT s.* FROM submissions s JOIN enrollments e ON e.id = s.enrollment_id WHERE s.id = ? AND e.student_id = ? AND s.status = 'READY'`, id, req.user.id);
  if (!s) throw E.notFound();
  const ctx = loadForAction(req, s.assignment_id);
  if (ctx.e.id !== s.enrollment_id) throw E.notFound();
  return { s, ...ctx };
}
// 수정: 기존 버전을 덮어쓰지 않고 새 버전 추가
r.patch('/submissions/:id', (req, res) => {
  let aid;
  tx(() => {
    const { s, a } = loadOwnSubmission(req, req.params.id);
    aid = a.id;
    let url = null; let fileId = null;
    if (s.type === 'LINK') {
      url = String(req.body.url || '').trim();
      if (!U.isSafeUrl(url)) throw E.invalid('http:// 또는 https:// 로 시작하는 링크를 입력해주세요.');
    } else fileId = takeFile(req, req.body.file_id); // 새 파일 등록이 성공한 후에만 교체
    const t = U.serverNow().toISOString();
    const rev = s.current_revision + 1;
    run(`INSERT INTO submission_versions(submission_id, revision, type, file_id_optional, url_optional, created_at, created_by) VALUES(?,?,?,?,?,?,?)`, s.id, rev, s.type, fileId, url, t, req.user.id);
    run('UPDATE submissions SET current_revision = ? WHERE id = ?', rev, s.id);
    const tp = get('SELECT * FROM task_progress WHERE enrollment_id = ? AND assignment_id = ?', s.enrollment_id, a.id);
    run('INSERT INTO progress_events(task_progress_id, event_type, submission_id_optional, occurred_at, metadata) VALUES(?,?,?,?,?)', tp.id, 'SUBMISSION_REVISED', s.id, t, JSON.stringify({ revision: rev }));
    P.recompute(tp.id);
  });
  res.json(assignmentDetail(req, aid));
});
r.delete('/submissions/:id', (req, res) => {
  let aid;
  tx(() => {
    const { s, a } = loadOwnSubmission(req, req.params.id);
    aid = a.id;
    const t = U.serverNow().toISOString();
    run(`UPDATE submissions SET status = 'REMOVED', removed_at = ? WHERE id = ?`, t, s.id);
    const tp = get('SELECT * FROM task_progress WHERE enrollment_id = ? AND assignment_id = ?', s.enrollment_id, a.id);
    run('INSERT INTO progress_events(task_progress_id, event_type, submission_id_optional, occurred_at) VALUES(?,?,?,?)', tp.id, 'SUBMISSION_REMOVED', s.id, t);
    P.recompute(tp.id);
  });
  res.json(assignmentDetail(req, aid));
});

// 피드백 읽음 (열람 권한이 있는 동안 마감과 무관하게 허용)
r.post('/feedback/:id/read', (req, res) => {
  const f = get('SELECT * FROM feedback WHERE id = ? AND deleted_at IS NULL', req.params.id);
  if (!f) throw E.notFound();
  const e = get(`SELECT * FROM enrollments WHERE id = ? AND student_id = ? AND status = 'ACTIVE'`, f.enrollment_id, req.user.id);
  if (!e) throw E.notFound();
  AC.loadAssignmentForStudent(req.user, f.assignment_id);
  run(`INSERT INTO feedback_reads(feedback_id, student_id, last_read_version, read_at) VALUES(?,?,?,?)
    ON CONFLICT(feedback_id, student_id) DO UPDATE SET last_read_version = excluded.last_read_version, read_at = excluded.read_at`, f.id, req.user.id, f.version, now());
  res.json({ ok: true });
});

module.exports = r;
