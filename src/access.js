'use strict';
// 3.3 접근권한 적용 원칙: 역할 + 강의 + 현재 배정·수강 등록 + 소유 관계를 매 요청 서버에서 확인한다.
const { get } = require('./db');
const { E } = require('./util');

async function isAssignedInstructor(user, courseId) {
  if (!user || user.type !== 'STAFF' || !user.instructorId) return false;
  return !!(await get(`SELECT 1 AS ok FROM course_instructors WHERE course_id = ? AND instructor_id = ? AND status = 'ACTIVE'`, courseId, user.instructorId));
}
async function canManageCourse(user, courseId) {
  if (!user || user.type !== 'STAFF') return false;
  return user.isAdmin || isAssignedInstructor(user, courseId);
}
async function activeEnrollment(user, courseId) {
  if (!user || user.type !== 'STUDENT') return null;
  return (await get(`SELECT * FROM enrollments WHERE course_id = ? AND student_id = ? AND status = 'ACTIVE'`, courseId, user.id)) || null;
}

// 존재 + 관리 권한을 함께 확인. 범위 밖이면 404. lock=true면 트랜잭션 안에서 행 잠금(동시 수정 직렬화).
const FU = (lock) => (lock ? ' FOR UPDATE' : '');
async function loadCourseForStaff(user, courseId, lock) {
  const c = await get('SELECT * FROM courses WHERE id = ?' + FU(lock), courseId);
  if (!c || !(await canManageCourse(user, courseId))) throw E.notFound();
  return c;
}
async function loadChallengeForStaff(user, id, lock) {
  const ch = await get('SELECT * FROM challenges WHERE id = ?' + FU(lock), id);
  if (!ch || !(await canManageCourse(user, ch.course_id))) throw E.notFound();
  return ch;
}
async function loadAssignmentForStaff(user, id, lock) {
  const a = await get('SELECT * FROM assignments WHERE id = ?' + FU(lock), id);
  if (!a || !(await canManageCourse(user, a.course_id))) throw E.notFound();
  return a;
}
async function loadEnrollmentForStaff(user, id) {
  const e = await get('SELECT * FROM enrollments WHERE id = ?', id);
  if (!e || !(await canManageCourse(user, e.course_id))) throw E.notFound();
  return e;
}

// 학생: 활성 등록 + 챌린지·과제 모두 공개된 과제만. lock=true면 과제 행을 잠가 강사 수정과 순서를 확정한다.
async function loadAssignmentForStudent(user, id, lock) {
  const a = await get(`SELECT a.*, c.visibility AS ch_visibility FROM assignments a JOIN challenges c ON c.id = a.challenge_id WHERE a.id = ?`
    + (lock ? ' FOR UPDATE OF a' : ''), id);
  if (!a || a.visibility !== 'PUBLISHED' || a.ch_visibility !== 'PUBLISHED') throw E.notFound();
  const enr = await activeEnrollment(user, a.course_id);
  if (!enr) throw E.notFound();
  return { assignment: a, enrollment: enr };
}

// 11.2 파일 다운로드 권한: 현재 사용자가 접근 가능한 연결(자료·제출 버전)이 하나라도 있는지 확인
async function canDownloadFile(user, fileId) {
  if (!user) return false;
  if (user.type === 'STAFF') {
    if (user.isAdmin) return true;
    if (!user.instructorId) return false;
    if (await get(`SELECT 1 AS ok FROM assignment_resources r JOIN assignments a ON a.id = r.assignment_id
      JOIN course_instructors ci ON ci.course_id = a.course_id AND ci.instructor_id = ? AND ci.status = 'ACTIVE'
      WHERE r.file_id_optional = ? LIMIT 1`, user.instructorId, fileId)) return true;
    if (await get(`SELECT 1 AS ok FROM submission_versions v JOIN submissions s ON s.id = v.submission_id
      JOIN course_instructors ci ON ci.course_id = s.course_id AND ci.instructor_id = ? AND ci.status = 'ACTIVE'
      WHERE v.file_id_optional = ? LIMIT 1`, user.instructorId, fileId)) return true;
    // 본인이 막 업로드했지만 아직 연결하지 않은 자료
    return !!(await get(`SELECT 1 AS ok FROM file_assets WHERE id = ? AND uploaded_by_type = 'STAFF' AND uploaded_by = ? AND status = 'UPLOADED'`, fileId, user.id));
  }
  if (await get(`SELECT 1 AS ok FROM assignment_resources r JOIN assignments a ON a.id = r.assignment_id
    JOIN challenges ch ON ch.id = a.challenge_id
    JOIN enrollments e ON e.course_id = a.course_id AND e.student_id = ? AND e.status = 'ACTIVE'
    WHERE r.file_id_optional = ? AND r.removed_at IS NULL AND a.visibility = 'PUBLISHED' AND ch.visibility = 'PUBLISHED' LIMIT 1`, user.id, fileId)) return true;
  if (await get(`SELECT 1 AS ok FROM submission_versions v JOIN submissions s ON s.id = v.submission_id
    JOIN enrollments e ON e.id = s.enrollment_id AND e.student_id = ? AND e.status = 'ACTIVE'
    JOIN assignments a ON a.id = s.assignment_id JOIN challenges ch ON ch.id = a.challenge_id
    WHERE v.file_id_optional = ? AND a.visibility = 'PUBLISHED' AND ch.visibility = 'PUBLISHED' LIMIT 1`, user.id, fileId)) return true;
  return !!(await get(`SELECT 1 AS ok FROM file_assets WHERE id = ? AND uploaded_by_type = 'STUDENT' AND uploaded_by = ? AND status = 'UPLOADED'`, fileId, user.id));
}

module.exports = {
  isAssignedInstructor, canManageCourse, activeEnrollment, loadCourseForStaff, loadChallengeForStaff,
  loadAssignmentForStaff, loadEnrollmentForStaff, loadAssignmentForStudent, canDownloadFile,
};
