'use strict';
// 3.3 접근권한 적용 원칙: 역할 + 강의 + 현재 배정·수강 등록 + 소유 관계를 매 요청 서버에서 확인한다.
const { get } = require('./db');
const { E } = require('./util');

function isAssignedInstructor(user, courseId) {
  if (!user || user.type !== 'STAFF' || !user.instructorId) return false;
  return !!get(`SELECT 1 FROM course_instructors WHERE course_id = ? AND instructor_id = ? AND status = 'ACTIVE'`, courseId, user.instructorId);
}
function canManageCourse(user, courseId) {
  if (!user || user.type !== 'STAFF') return false;
  return user.isAdmin || isAssignedInstructor(user, courseId);
}
function activeEnrollment(user, courseId) {
  if (!user || user.type !== 'STUDENT') return null;
  return get(`SELECT * FROM enrollments WHERE course_id = ? AND student_id = ? AND status = 'ACTIVE'`, courseId, user.id) || null;
}

// 존재 + 관리 권한을 함께 확인. 범위 밖이면 404.
function loadCourseForStaff(user, courseId) {
  const c = get('SELECT * FROM courses WHERE id = ?', courseId);
  if (!c || !canManageCourse(user, courseId)) throw E.notFound();
  return c;
}
function loadChallengeForStaff(user, id) {
  const ch = get('SELECT * FROM challenges WHERE id = ?', id);
  if (!ch || !canManageCourse(user, ch.course_id)) throw E.notFound();
  return ch;
}
function loadAssignmentForStaff(user, id) {
  const a = get('SELECT * FROM assignments WHERE id = ?', id);
  if (!a || !canManageCourse(user, a.course_id)) throw E.notFound();
  return a;
}
function loadEnrollmentForStaff(user, id) {
  const e = get('SELECT * FROM enrollments WHERE id = ?', id);
  if (!e || !canManageCourse(user, e.course_id)) throw E.notFound();
  return e;
}

// 학생: 활성 등록 + 챌린지·과제 모두 공개된 과제만
function loadAssignmentForStudent(user, id) {
  const a = get(`SELECT a.*, c.visibility AS ch_visibility FROM assignments a JOIN challenges c ON c.id = a.challenge_id WHERE a.id = ?`, id);
  if (!a || a.visibility !== 'PUBLISHED' || a.ch_visibility !== 'PUBLISHED') throw E.notFound();
  const enr = activeEnrollment(user, a.course_id);
  if (!enr) throw E.notFound();
  return { assignment: a, enrollment: enr };
}

// 11.2 파일 다운로드 권한: 현재 사용자가 접근 가능한 연결(자료·제출 버전·명단)이 하나라도 있는지 확인
function canDownloadFile(user, fileId) {
  if (!user) return false;
  if (user.type === 'STAFF') {
    if (user.isAdmin) return true;
    if (!user.instructorId) return false;
    const viaResource = get(`SELECT 1 FROM assignment_resources r JOIN assignments a ON a.id = r.assignment_id
      JOIN course_instructors ci ON ci.course_id = a.course_id AND ci.instructor_id = ? AND ci.status = 'ACTIVE'
      WHERE r.file_id_optional = ? LIMIT 1`, user.instructorId, fileId);
    if (viaResource) return true;
    const viaSub = get(`SELECT 1 FROM submission_versions v JOIN submissions s ON s.id = v.submission_id
      JOIN course_instructors ci ON ci.course_id = s.course_id AND ci.instructor_id = ? AND ci.status = 'ACTIVE'
      WHERE v.file_id_optional = ? LIMIT 1`, user.instructorId, fileId);
    if (viaSub) return true;
    // 본인이 막 업로드했지만 아직 연결하지 않은 자료
    return !!get(`SELECT 1 FROM file_assets WHERE id = ? AND uploaded_by_type = 'STAFF' AND uploaded_by = ? AND status = 'UPLOADED'`, fileId, user.id);
  }
  // 학생
  const viaResource = get(`SELECT 1 FROM assignment_resources r JOIN assignments a ON a.id = r.assignment_id
    JOIN challenges ch ON ch.id = a.challenge_id
    JOIN enrollments e ON e.course_id = a.course_id AND e.student_id = ? AND e.status = 'ACTIVE'
    WHERE r.file_id_optional = ? AND r.removed_at IS NULL AND a.visibility = 'PUBLISHED' AND ch.visibility = 'PUBLISHED' LIMIT 1`, user.id, fileId);
  if (viaResource) return true;
  const viaSub = get(`SELECT 1 FROM submission_versions v JOIN submissions s ON s.id = v.submission_id
    JOIN enrollments e ON e.id = s.enrollment_id AND e.student_id = ? AND e.status = 'ACTIVE'
    JOIN assignments a ON a.id = s.assignment_id JOIN challenges ch ON ch.id = a.challenge_id
    WHERE v.file_id_optional = ? AND a.visibility = 'PUBLISHED' AND ch.visibility = 'PUBLISHED' LIMIT 1`, user.id, fileId);
  if (viaSub) return true;
  return !!get(`SELECT 1 FROM file_assets WHERE id = ? AND uploaded_by_type = 'STUDENT' AND uploaded_by = ? AND status = 'UPLOADED'`, fileId, user.id);
}

module.exports = {
  isAssignedInstructor, canManageCourse, activeEnrollment, loadCourseForStaff, loadChallengeForStaff,
  loadAssignmentForStaff, loadEnrollmentForStaff, loadAssignmentForStudent, canDownloadFile,
};
