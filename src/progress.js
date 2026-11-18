'use strict';
// 10장 자동 완료 규칙 · 13장 집계 기준
const { get, all, run, uuid } = require('./db');
const { E, serverNow, pct } = require('./util');

// 8.3 상태별 학생 동작 판단 (최신 챌린지 기간·설정 기준)
function actionState(challenge, assignment, enrollment) {
  if (!enrollment || enrollment.status !== 'ACTIVE') return { canAct: false, code: 'NO_ACCESS', message: '이 강의에 접근할 수 없습니다. 운영자에게 문의해주세요.' };
  if (challenge.visibility !== 'PUBLISHED' || assignment.visibility !== 'PUBLISHED') return { canAct: false, code: 'DRAFT', message: '공개되지 않은 과제입니다.' };
  const t = serverNow().getTime();
  if (t < Date.parse(challenge.starts_at)) return { canAct: false, code: 'NOT_STARTED', message: '챌린지 시작일부터 체크와 제출이 가능합니다.' };
  if (t >= Date.parse(challenge.deadline_at)) {
    if (challenge.allow_after_deadline) return { canAct: true, code: 'AFTER_DEADLINE_OPEN', message: '기한 후에도 수행할 수 있습니다. 새로 완료하면 기한 후 완료로 표시됩니다.' };
    return { canAct: false, code: 'CLOSED', message: '제출 기간이 종료되어 조회만 가능합니다.' };
  }
  return { canAct: true, code: 'OPEN', message: null };
}
function assertCanAct(challenge, assignment, enrollment) {
  const s = actionState(challenge, assignment, enrollment);
  if (!s.canAct) throw E.conflict(s.message, { reason: s.code });
  return s;
}

function ensureTaskProgress(enrollment, assignment) {
  let tp = get('SELECT * FROM task_progress WHERE enrollment_id = ? AND assignment_id = ?', enrollment.id, assignment.id);
  if (!tp) {
    run(`INSERT INTO task_progress(id, course_id, enrollment_id, assignment_id) VALUES(?,?,?,?)`,
      uuid(), assignment.course_id, enrollment.id, assignment.id);
    tp = get('SELECT * FROM task_progress WHERE enrollment_id = ? AND assignment_id = ?', enrollment.id, assignment.id);
  }
  return tp;
}

// 첫 수행 확정 시 과제 동결 + 학생 기록 시작 시각
function markStarted(tp, assignment, at) {
  if (!tp.started_at) run('UPDATE task_progress SET started_at = ? WHERE id = ?', at, tp.id);
  run('UPDATE assignments SET locked_at = ? WHERE id = ? AND locked_at IS NULL', at, assignment.id);
}

function counts(tpId, assignmentId) {
  const items = get('SELECT COUNT(*) n FROM checklist_items WHERE assignment_id = ?', assignmentId).n;
  const checked = tpId ? get('SELECT COUNT(*) n FROM item_progress WHERE task_progress_id = ? AND is_checked = 1', tpId).n : 0;
  return { items, checked };
}
function currentSubmissionCount(enrollmentId, assignmentId) {
  // READY 상태이며 현재 버전 파일이 정상 연결(ATTACHED)된 경우만 센다.
  return get(`SELECT COUNT(*) n FROM submissions s JOIN submission_versions v ON v.submission_id = s.id AND v.revision = s.current_revision
    LEFT JOIN file_assets f ON f.id = v.file_id_optional
    WHERE s.enrollment_id = ? AND s.assignment_id = ? AND s.status = 'READY'
      AND (v.type = 'LINK' OR f.status = 'ATTACHED')`, enrollmentId, assignmentId).n;
}

// 서버가 원천 데이터로 완료 여부를 다시 계산한다(트랜잭션 내부에서 호출).
function recompute(tpId) {
  const tp = get('SELECT * FROM task_progress WHERE id = ?', tpId);
  const a = get('SELECT * FROM assignments WHERE id = ?', tp.assignment_id);
  const ch = get('SELECT * FROM challenges WHERE id = ?', a.challenge_id);
  const { items, checked } = counts(tp.id, a.id);
  const subs = currentSubmissionCount(tp.enrollment_id, a.id);
  const complete = items >= 1 && checked === items && (!a.submission_required || subs >= 1);
  const at = serverNow().toISOString();
  if (complete && !tp.is_completed) {
    const timing = Date.parse(at) < Date.parse(ch.deadline_at) ? 'ON_TIME' : 'LATE';
    run(`UPDATE task_progress SET is_completed = 1, completed_at = ?, completed_deadline_at = ?, completion_timing = ?, version = version + 1 WHERE id = ?`,
      at, ch.deadline_at, timing, tp.id);
    run(`INSERT INTO progress_events(task_progress_id, event_type, occurred_at, metadata) VALUES(?,?,?,?)`,
      tp.id, 'COMPLETED', at, JSON.stringify({ deadline_at: ch.deadline_at, timing }));
  } else if (!complete && tp.is_completed) {
    run(`UPDATE task_progress SET is_completed = 0, completed_at = NULL, completed_deadline_at = NULL, completion_timing = NULL, version = version + 1 WHERE id = ?`, tp.id);
    run(`INSERT INTO progress_events(task_progress_id, event_type, occurred_at, metadata) VALUES(?,?,?,?)`,
      tp.id, 'UNCOMPLETED', at, JSON.stringify({ previous_completed_at: tp.completed_at }));
  }
  return get('SELECT * FROM task_progress WHERE id = ?', tp.id);
}

// 10.2 표시 상태
function statusOf({ started, completed, timing, items, checked, subs, required }) {
  if (completed) return timing === 'LATE' ? 'COMPLETED_LATE' : 'COMPLETED';
  if (!started) return 'NOT_STARTED';
  if (items > 0 && checked === items && required && subs === 0) return 'NEED_SUBMISSION';
  return 'IN_PROGRESS';
}
const STATUS_LABEL = {
  NOT_STARTED: '미시작', IN_PROGRESS: '진행 중', NEED_SUBMISSION: '결과물 제출 필요',
  COMPLETED: '완료', COMPLETED_LATE: '완료 · 기한 후 완료',
};

// 공개 과제 집합(챌린지·과제 모두 공개)
function publishedAssignments(courseId, challengeId = null) {
  return all(`SELECT a.id, a.title, a.challenge_id, a.submission_required, a.sort_order, c.title AS challenge_title,
      c.starts_at, c.deadline_at, c.sort_order AS ch_sort,
      (SELECT COUNT(*) FROM checklist_items i WHERE i.assignment_id = a.id) AS item_count
    FROM assignments a JOIN challenges c ON c.id = a.challenge_id
    WHERE a.course_id = ? AND a.visibility = 'PUBLISHED' AND c.visibility = 'PUBLISHED' AND (? IS NULL OR c.id = ?)
    ORDER BY c.sort_order, c.start_date, c.created_at, a.sort_order, a.created_at`, courseId, challengeId, challengeId);
}

// 수강 등록 집합의 과제별 셀 상태 (진행 행이 없어도 미시작으로 보완)
function cellMatrix(courseId, enrollmentIds, assignments) {
  const map = new Map();
  if (!enrollmentIds.length || !assignments.length) return map;
  const ph = enrollmentIds.map(() => '?').join(',');
  const tps = all(`SELECT tp.*, (SELECT COUNT(*) FROM item_progress ip WHERE ip.task_progress_id = tp.id AND ip.is_checked = 1) AS checked
    FROM task_progress tp WHERE tp.course_id = ? AND tp.enrollment_id IN (${ph})`, courseId, ...enrollmentIds);
  const subs = all(`SELECT s.enrollment_id, s.assignment_id, COUNT(*) n FROM submissions s
    JOIN submission_versions v ON v.submission_id = s.id AND v.revision = s.current_revision
    LEFT JOIN file_assets f ON f.id = v.file_id_optional
    WHERE s.course_id = ? AND s.status = 'READY' AND (v.type = 'LINK' OR f.status = 'ATTACHED') AND s.enrollment_id IN (${ph})
    GROUP BY s.enrollment_id, s.assignment_id`, courseId, ...enrollmentIds);
  const unread = all(`SELECT f.enrollment_id, f.assignment_id, COUNT(*) n FROM feedback f
    JOIN enrollments e ON e.id = f.enrollment_id
    LEFT JOIN feedback_reads r ON r.feedback_id = f.id AND r.student_id = e.student_id
    WHERE f.course_id = ? AND f.deleted_at IS NULL AND (r.last_read_version IS NULL OR r.last_read_version < f.version) AND f.enrollment_id IN (${ph})
    GROUP BY f.enrollment_id, f.assignment_id`, courseId, ...enrollmentIds);
  const tpMap = new Map(tps.map((t) => [t.enrollment_id + '|' + t.assignment_id, t]));
  const subMap = new Map(subs.map((s) => [s.enrollment_id + '|' + s.assignment_id, s.n]));
  const unreadMap = new Map(unread.map((s) => [s.enrollment_id + '|' + s.assignment_id, s.n]));
  for (const eid of enrollmentIds) {
    for (const a of assignments) {
      const k = eid + '|' + a.id;
      const tp = tpMap.get(k);
      const cell = {
        items: a.item_count, checked: tp ? tp.checked : 0, subs: subMap.get(k) || 0,
        started: !!(tp && tp.started_at), completed: !!(tp && tp.is_completed), timing: tp ? tp.completion_timing : null,
        completed_at: tp ? tp.completed_at : null, required: !!a.submission_required, unread_feedback: unreadMap.get(k) || 0,
      };
      cell.status = statusOf(cell);
      map.set(k, cell);
    }
  }
  return map;
}

// 강의별 집계 (정수 건수 합산, 0 나눗셈 방지)
function courseStats(courseIds) {
  const out = new Map();
  if (!courseIds.length) return out;
  const ph = courseIds.map(() => '?').join(',');
  const rows = (sql) => all(sql, ...courseIds);
  const act = rows(`SELECT e.course_id, COUNT(*) n FROM enrollments e JOIN students s ON s.id = e.student_id
    WHERE e.status = 'ACTIVE' AND s.status = 'ACTIVE' AND e.course_id IN (${ph}) GROUP BY e.course_id`);
  const pub = rows(`SELECT a.course_id, COUNT(*) n FROM assignments a JOIN challenges c ON c.id = a.challenge_id
    WHERE a.visibility = 'PUBLISHED' AND c.visibility = 'PUBLISHED' AND a.course_id IN (${ph}) GROUP BY a.course_id`);
  const tpAgg = rows(`SELECT tp.course_id,
      SUM(tp.is_completed) AS completed,
      SUM(CASE WHEN tp.is_completed = 1 AND tp.completion_timing = 'LATE' THEN 1 ELSE 0 END) AS late,
      SUM(CASE WHEN tp.started_at IS NOT NULL THEN 1 ELSE 0 END) AS started,
      SUM(CASE WHEN tp.is_completed = 0 AND a.submission_required = 1
        AND (SELECT COUNT(*) FROM checklist_items i WHERE i.assignment_id = a.id) > 0
        AND (SELECT COUNT(*) FROM item_progress ip WHERE ip.task_progress_id = tp.id AND ip.is_checked = 1)
          = (SELECT COUNT(*) FROM checklist_items i WHERE i.assignment_id = a.id) THEN 1 ELSE 0 END) AS need_sub
    FROM task_progress tp
    JOIN enrollments e ON e.id = tp.enrollment_id AND e.status = 'ACTIVE'
    JOIN students s ON s.id = e.student_id AND s.status = 'ACTIVE'
    JOIN assignments a ON a.id = tp.assignment_id AND a.visibility = 'PUBLISHED'
    JOIN challenges c ON c.id = a.challenge_id AND c.visibility = 'PUBLISHED'
    WHERE tp.course_id IN (${ph}) GROUP BY tp.course_id`);
  const chs = rows(`SELECT course_id, COUNT(*) n FROM challenges WHERE course_id IN (${ph}) GROUP BY course_id`);
  const m = (arr) => new Map(arr.map((r) => [r.course_id, r]));
  const actM = m(act), pubM = m(pub), tpM = m(tpAgg), chM = m(chs);
  for (const id of courseIds) {
    const students = actM.get(id)?.n || 0;
    const assignments = pubM.get(id)?.n || 0;
    const t = tpM.get(id) || {};
    const target = students * assignments;
    out.set(id, {
      active_students: students, published_assignments: assignments, challenges: chM.get(id)?.n || 0,
      completed: t.completed || 0, late: t.late || 0, need_submission: t.need_sub || 0,
      not_started: target - (t.started || 0), target, rate: pct(t.completed || 0, target),
    });
  }
  return out;
}

module.exports = {
  actionState, assertCanAct, ensureTaskProgress, markStarted, recompute, counts, currentSubmissionCount,
  statusOf, STATUS_LABEL, publishedAssignments, cellMatrix, courseStats,
};
