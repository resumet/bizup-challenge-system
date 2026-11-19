'use strict';
// 학생 이름·전화번호·상태 정정 (관리자 전체 학생 관리와 강사 수강생 수정이 함께 사용)
// 학생은 강의마다 별개이므로 정정은 그 강의의 학생에게만 반영된다.
// 같은 학생 ID를 유지하고, 같은 강의 안의 전화번호 중복은 거부하며, 로그인 정보가 바뀌면 기존 세션을 취소한다.
const { get, run, tx, now } = require('./db');
const U = require('./util');
const { E } = U;
const A = require('./auth');

async function correctStudent(req, s, body, { allowStatus = true, courseId = null } = {}) {
  const name = body.name !== undefined ? U.normalizeName(U.str(body.name, 50)) : s.normalized_name;
  if (!name) throw E.invalid('이름을 입력해주세요.');
  let phone = s.normalized_phone;
  if (body.phone !== undefined && body.phone !== null && String(body.phone).trim() !== '') {
    phone = U.normalizePhone(body.phone);
    if (!phone) throw E.invalid(U.phoneError(body.phone));
  }
  const status = allowStatus && body.status !== undefined ? body.status : s.status;
  if (!['ACTIVE', 'DISABLED'].includes(status)) throw E.invalid('상태 값이 올바르지 않습니다.');
  const affected = 1;
  const loginChanged = name !== s.normalized_name || phone !== s.normalized_phone;
  if (body.dry_run) return { affected_courses: affected, login_changed: loginChanged };
  const reason = (U.str(body.reason, 500) || '').trim();
  if ((loginChanged || status !== s.status) && !reason) throw E.invalid('변경 사유를 입력해주세요.');
  if (!loginChanged && status === s.status) return { id: s.id, affected_courses: affected, changed: false };
  const DUP = '이 강의의 다른 수강생이 이미 사용 중인 전화번호입니다. 저장하지 않았습니다.';
  const dupSql = 'SELECT 1 AS ok FROM students WHERE course_id = ? AND normalized_phone = ? AND id != ?';
  if (phone !== s.normalized_phone && await get(dupSql, s.course_id, phone, s.id)) throw E.conflict(DUP);
  const hash = phone !== s.normalized_phone ? await A.hashPassword(phone, 'STUDENT') : null;
  return tx(async () => {
    const cur = await get('SELECT * FROM students WHERE id = ? FOR UPDATE', s.id);
    if (phone !== cur.normalized_phone && await get(dupSql, cur.course_id, phone, s.id)) throw E.conflict(DUP);
    await run('UPDATE students SET name = ?, normalized_name = ?, normalized_phone = ?, status = ?, updated_at = ? WHERE id = ?', name, name, phone, status, now(), s.id);
    if (hash) await run('UPDATE student_credentials SET password_hash = ?, credential_version = credential_version + 1 WHERE student_id = ?', hash, s.id);
    else if (loginChanged) await run('UPDATE student_credentials SET credential_version = credential_version + 1 WHERE student_id = ?', s.id);
    if (loginChanged || status === 'DISABLED') await A.revokeSubjectSessions('STUDENT', s.id);
    const changed = {};
    if (name !== cur.normalized_name) changed.name = [cur.name, name];
    if (phone !== cur.normalized_phone) changed.phone = [U.maskPhone(cur.normalized_phone), U.maskPhone(phone)];
    if (status !== cur.status) changed.status = [cur.status, status];
    await A.audit(req, { courseId: courseId || cur.course_id, targetType: 'STUDENT', targetId: s.id, action: 'STUDENT_CORRECTED', changed, reason, restricted: true });
    return { id: s.id, affected_courses: affected, changed: true };
  });
}

module.exports = { correctStudent };
