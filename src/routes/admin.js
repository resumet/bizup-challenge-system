'use strict';
const express = require('express');
const { get, all, run, tx, uuid, now, nextCode } = require('../db');
const U = require('../util');
const { E } = U;
const A = require('../auth');
const P = require('../progress');
const { isAssignedInstructor } = require('../access');

const r = express.Router();
const SETUP_TTL_MS = 24 * 3600 * 1000;

function issueSetupToken(req, staffId) {
  const token = U.randomToken(32);
  const st = get('SELECT password_hash FROM staff_accounts WHERE id = ?', staffId);
  run('UPDATE staff_tokens SET revoked_at = ? WHERE staff_id = ? AND used_at IS NULL AND revoked_at IS NULL', now(), staffId);
  run(`INSERT INTO staff_tokens(id, staff_id, token_hash, purpose, expires_at, created_by, created_at) VALUES(?,?,?,?,?,?,?)`,
    uuid(), staffId, U.sha256(token), st.password_hash ? 'RESET' : 'SETUP', new Date(Date.now() + SETUP_TTL_MS).toISOString(), req.user.id, now());
  return { setup_path: `/#/setup/${token}`, expires_at: new Date(Date.now() + SETUP_TTL_MS).toISOString() };
}

function staffView(a) {
  const roles = all('SELECT role FROM staff_roles WHERE staff_id = ? ORDER BY role', a.id).map((x) => x.role);
  const ins = get('SELECT id, code, phone_optional FROM instructors WHERE staff_id = ?', a.id);
  const courses = ins ? all(`SELECT c.id, c.code, c.title, c.cohort_label, c.state FROM course_instructors ci JOIN courses c ON c.id = ci.course_id
    WHERE ci.instructor_id = ? AND ci.status = 'ACTIVE' ORDER BY c.created_at DESC`, ins.id) : [];
  return {
    id: a.id, email: a.email, name: a.name, status: a.status, roles, last_login_at: a.last_login_at, created_at: a.created_at,
    has_password: !!a.password_hash, instructor_id: ins ? ins.id : null, instructor_code: ins ? ins.code : null,
    phone: ins ? ins.phone_optional : null, courses,
  };
}
function activeAdminCount(excludeId) {
  return get(`SELECT COUNT(*) n FROM staff_accounts a JOIN staff_roles r ON r.staff_id = a.id AND r.role = 'ADMIN'
    WHERE a.status = 'ACTIVE' AND a.id != ?`, excludeId || '').n;
}

// ---------- 운영자(강사·관리자) 계정 ----------
r.get('/staff', A.requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  const role = req.query.role;
  const rows = all(`SELECT * FROM staff_accounts a WHERE (? = '' OR a.name LIKE ? OR a.email LIKE ?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM staff_roles r WHERE r.staff_id = a.id AND r.role = ?)) ORDER BY a.created_at DESC`,
  q, `%${q}%`, `%${q}%`, role || null, role || null);
  res.json({ items: rows.map(staffView) });
});

function ensureInstructor(staffId, name, phone) {
  const ins = get('SELECT * FROM instructors WHERE staff_id = ?', staffId);
  if (ins) { run('UPDATE instructors SET name = ?, phone_optional = COALESCE(?, phone_optional) WHERE id = ?', name, phone, ins.id); return ins.id; }
  const id = uuid();
  run('INSERT INTO instructors(id, code, staff_id, name, phone_optional) VALUES(?,?,?,?,?)', id, nextCode('INS'), staffId, name, phone);
  return id;
}
function parseRoles(roles) {
  const rs = [...new Set((Array.isArray(roles) ? roles : []).filter((x) => x === 'ADMIN' || x === 'INSTRUCTOR'))];
  if (!rs.length) throw E.invalid('역할을 1개 이상 선택해주세요.');
  return rs;
}

r.post('/staff', A.requireAdmin, (req, res) => {
  const email = U.requireStr(req.body.email, '이메일', 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw E.invalid('이메일 형식을 확인해주세요.');
  const name = U.requireStr(req.body.name, '이름', 50);
  const roles = parseRoles(req.body.roles);
  const phone = req.body.phone ? U.normalizePhone(req.body.phone) : null;
  if (req.body.phone && !phone) throw E.invalid('강사 연락처 형식을 확인해주세요.');
  const out = tx(() => {
    if (get('SELECT 1 FROM staff_accounts WHERE email = ?', email)) throw E.conflict('이미 등록된 이메일입니다.');
    const id = uuid();
    run(`INSERT INTO staff_accounts(id, email, name, status, created_at, updated_at) VALUES(?,?,?,?,?,?)`, id, email, name, 'PENDING', now(), now());
    roles.forEach((x) => run('INSERT INTO staff_roles(staff_id, role) VALUES(?,?)', id, x));
    if (roles.includes('INSTRUCTOR')) ensureInstructor(id, name, phone);
    const link = issueSetupToken(req, id);
    A.audit(req, { targetType: 'STAFF', targetId: id, action: 'STAFF_CREATED', changed: { email, roles } });
    return { staff: staffView(get('SELECT * FROM staff_accounts WHERE id = ?', id)), ...link };
  });
  res.status(201).json(out);
});

r.patch('/staff/:id', A.requireAdmin, (req, res) => {
  const out = tx(() => {
    const a = get('SELECT * FROM staff_accounts WHERE id = ?', req.params.id);
    if (!a) throw E.notFound();
    const changed = {};
    const curRoles = all('SELECT role FROM staff_roles WHERE staff_id = ?', a.id).map((x) => x.role);
    let name = a.name;
    if (req.body.name !== undefined) { name = U.requireStr(req.body.name, '이름', 50); if (name !== a.name) changed.name = [a.name, name]; }
    let status = a.status;
    if (req.body.status !== undefined) {
      if (req.body.status === 'DISABLED') status = 'DISABLED';
      else if (req.body.status === 'ACTIVE') status = a.password_hash ? 'ACTIVE' : 'PENDING';
      else throw E.invalid('상태 값이 올바르지 않습니다.');
    }
    let roles = curRoles;
    if (req.body.roles !== undefined) roles = parseRoles(req.body.roles);
    const wasActiveAdmin = a.status === 'ACTIVE' && curRoles.includes('ADMIN');
    const willBeActiveAdmin = status === 'ACTIVE' && roles.includes('ADMIN');
    if (wasActiveAdmin && !willBeActiveAdmin && activeAdminCount(a.id) === 0) {
      throw E.conflict('마지막 활성 관리자는 비활성화하거나 관리자 권한을 제거할 수 없습니다.');
    }
    if (status !== a.status) changed.status = [a.status, status];
    if (roles.join() !== curRoles.join()) changed.roles = [curRoles, roles];
    run('UPDATE staff_accounts SET name = ?, status = ?, updated_at = ? WHERE id = ?', name, status, now(), a.id);
    run('DELETE FROM staff_roles WHERE staff_id = ?', a.id);
    roles.forEach((x) => run('INSERT INTO staff_roles(staff_id, role) VALUES(?,?)', a.id, x));
    const phone = req.body.phone !== undefined ? (req.body.phone ? U.normalizePhone(req.body.phone) : null) : undefined;
    if (req.body.phone && !phone) throw E.invalid('강사 연락처 형식을 확인해주세요.');
    if (roles.includes('INSTRUCTOR')) ensureInstructor(a.id, name, phone);
    else if (get('SELECT 1 FROM instructors WHERE staff_id = ?', a.id)) run('UPDATE instructors SET name = ? WHERE staff_id = ?', name, a.id);
    if (status === 'DISABLED' && a.status !== 'DISABLED') A.revokeSubjectSessions('STAFF', a.id); // 계정 전체 비활성화 → 모든 세션 중단
    if (Object.keys(changed).length) A.audit(req, { targetType: 'STAFF', targetId: a.id, action: 'STAFF_UPDATED', changed });
    return staffView(get('SELECT * FROM staff_accounts WHERE id = ?', a.id));
  });
  res.json(out);
});

r.post('/staff/:id/setup-link', A.requireAdmin, (req, res) => {
  const out = tx(() => {
    const a = get('SELECT * FROM staff_accounts WHERE id = ?', req.params.id);
    if (!a) throw E.notFound();
    const link = issueSetupToken(req, a.id);
    A.audit(req, { targetType: 'STAFF', targetId: a.id, action: 'SETUP_LINK_ISSUED' });
    return link;
  });
  res.json(out);
});

r.get('/instructors', A.requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  res.json({
    items: all(`SELECT i.id, i.code, i.name, a.email, a.status FROM instructors i JOIN staff_accounts a ON a.id = i.staff_id
      JOIN staff_roles r ON r.staff_id = a.id AND r.role = 'INSTRUCTOR'
      WHERE (? = '' OR i.name LIKE ? OR a.email LIKE ? OR i.code LIKE ?) ORDER BY i.name`, q, `%${q}%`, `%${q}%`, `%${q}%`),
  });
});

// ---------- 전체 학생 관리 (관리자) ----------
r.get('/students', A.requireAdmin, (req, res) => {
  const { page, size, offset } = U.pageParams(req.query);
  const q = U.normalizeName(req.query.q || '');
  const digits = q.replace(/\D/g, '');
  const where = `(? = '' OR s.normalized_name LIKE ? OR s.code LIKE ? OR (? != '' AND s.normalized_phone LIKE ?))`;
  const params = [q, `%${q}%`, `%${q.toUpperCase()}%`, digits, `%${digits}%`];
  const total = get(`SELECT COUNT(*) n FROM students s WHERE ${where}`, ...params).n;
  const items = all(`SELECT s.id, s.code, s.name, s.normalized_phone AS phone, s.status, s.created_at,
      (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = s.id AND e.status = 'ACTIVE') AS active_enrollments,
      (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = s.id) AS total_enrollments
    FROM students s WHERE ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, ...params, size, offset);
  res.json({ items, total, page, size });
});

r.get('/students/:id', A.requireAdmin, (req, res) => {
  const s = get('SELECT id, code, name, normalized_phone AS phone, status, created_at, updated_at FROM students WHERE id = ?', req.params.id);
  if (!s) throw E.notFound();
  s.enrollments = all(`SELECT e.id, e.status, e.enrolled_at, e.deactivated_at, e.reason, e.admin_memo,
      c.id AS course_id, c.code AS course_code, c.title, c.cohort_label, c.state
    FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = ? ORDER BY e.enrolled_at DESC`, s.id);
  res.json(s);
});

// 7.4 이름·전화번호 정정 (관리자만, 같은 학생 ID 유지, 충돌 시 거부, 세션 취소)
r.patch('/students/:id', A.requireAdmin, async (req, res) => {
  const s = get('SELECT * FROM students WHERE id = ?', req.params.id);
  if (!s) throw E.notFound();
  const name = req.body.name !== undefined ? U.normalizeName(U.str(req.body.name, 50)) : s.normalized_name;
  if (!name) throw E.invalid('이름을 입력해주세요.');
  let phone = s.normalized_phone;
  if (req.body.phone !== undefined) {
    phone = U.normalizePhone(req.body.phone);
    if (!phone) throw E.invalid(U.phoneError(req.body.phone));
  }
  const status = req.body.status !== undefined ? req.body.status : s.status;
  if (!['ACTIVE', 'DISABLED'].includes(status)) throw E.invalid('상태 값이 올바르지 않습니다.');
  const affected = get('SELECT COUNT(*) n FROM enrollments WHERE student_id = ?', s.id).n;
  const loginChanged = name !== s.normalized_name || phone !== s.normalized_phone;
  if (req.body.dry_run) return res.json({ affected_courses: affected, login_changed: loginChanged });
  const reason = (U.str(req.body.reason, 500) || '').trim();
  if ((loginChanged || status !== s.status) && !reason) throw E.invalid('변경 사유를 입력해주세요.');
  if (phone !== s.normalized_phone) {
    const other = get('SELECT id FROM students WHERE normalized_phone = ? AND id != ?', phone, s.id);
    if (other) throw E.conflict('다른 수강생이 이미 사용 중인 전화번호입니다. 저장하지 않았습니다.');
  }
  const hash = phone !== s.normalized_phone ? await A.hashPassword(phone, 'STUDENT') : null;
  const out = tx(() => {
    const cur = get('SELECT * FROM students WHERE id = ?', s.id);
    if (phone !== cur.normalized_phone && get('SELECT 1 FROM students WHERE normalized_phone = ? AND id != ?', phone, s.id)) {
      throw E.conflict('다른 수강생이 이미 사용 중인 전화번호입니다. 저장하지 않았습니다.');
    }
    run('UPDATE students SET name = ?, normalized_name = ?, normalized_phone = ?, status = ?, updated_at = ? WHERE id = ?', name, name, phone, status, now(), s.id);
    if (hash) run('UPDATE student_credentials SET password_hash = ?, credential_version = credential_version + 1 WHERE student_id = ?', hash, s.id);
    else if (loginChanged) run('UPDATE student_credentials SET credential_version = credential_version + 1 WHERE student_id = ?', s.id);
    if (loginChanged || status === 'DISABLED') A.revokeSubjectSessions('STUDENT', s.id);
    const changed = {};
    if (name !== cur.normalized_name) changed.name = [cur.name, name];
    if (phone !== cur.normalized_phone) changed.phone = [U.maskPhone(cur.normalized_phone), U.maskPhone(phone)];
    if (status !== cur.status) changed.status = [cur.status, status];
    A.audit(req, { targetType: 'STUDENT', targetId: s.id, action: 'STUDENT_CORRECTED', changed, reason, restricted: true });
    return { id: s.id, affected_courses: affected };
  });
  res.json(out);
});

// ---------- 관리자 대시보드 ----------
r.get('/admin/dashboard', A.requireAdmin, (req, res) => {
  const states = Object.fromEntries(all('SELECT state, COUNT(*) n FROM courses GROUP BY state').map((x) => [x.state, x.n]));
  const t = U.serverNow().toISOString();
  const courseIds = all(`SELECT id FROM courses WHERE state != 'ARCHIVED'`).map((x) => x.id);
  const stats = P.courseStats(courseIds);
  const sum = { completed: 0, target: 0, late: 0, need_submission: 0, not_started: 0 };
  for (const s of stats.values()) for (const k of Object.keys(sum)) sum[k] += s[k];
  res.json({
    courses: { READY: states.READY || 0, ACTIVE: states.ACTIVE || 0, ENDED: states.ENDED || 0, ARCHIVED: states.ARCHIVED || 0 },
    active_instructors: get(`SELECT COUNT(*) n FROM staff_accounts a JOIN staff_roles r ON r.staff_id = a.id AND r.role = 'INSTRUCTOR' WHERE a.status = 'ACTIVE'`).n,
    unique_students: get(`SELECT COUNT(DISTINCT e.student_id) n FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.status = 'ACTIVE' AND s.status = 'ACTIVE'`).n,
    total_students: get('SELECT COUNT(*) n FROM students').n,
    active_enrollments: get(`SELECT COUNT(*) n FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.status = 'ACTIVE' AND s.status = 'ACTIVE'`).n,
    running_challenges: get(`SELECT COUNT(*) n FROM challenges WHERE visibility = 'PUBLISHED' AND starts_at <= ? AND deadline_at > ?`, t, t).n,
    progress: { ...sum, rate: U.pct(sum.completed, sum.target) },
    note: '보관 강의는 집계에서 제외됩니다.',
  });
});

// ---------- 변경 이력 ----------
const INSTRUCTOR_LOG_TARGETS = ['CHALLENGE', 'ASSIGNMENT', 'RESOURCE', 'FEEDBACK'];
r.get('/audit-logs', A.requireStaff, (req, res) => {
  const { page, size, offset } = U.pageParams(req.query);
  const courseId = req.query.course_id || null;
  const conds = []; const params = [];
  if (!req.user.isAdmin) {
    if (!courseId || !isAssignedInstructor(req.user, courseId)) throw E.notFound();
    conds.push(`l.target_type IN (${INSTRUCTOR_LOG_TARGETS.map(() => '?').join(',')})`, 'l.restricted = 0');
    params.push(...INSTRUCTOR_LOG_TARGETS);
  }
  if (courseId) { conds.push('l.course_id_optional = ?'); params.push(courseId); }
  if (req.query.target_type) { conds.push('l.target_type = ?'); params.push(String(req.query.target_type)); }
  if (req.query.action) { conds.push('l.action LIKE ?'); params.push(`%${req.query.action}%`); }
  if (req.query.from) { conds.push('l.created_at >= ?'); params.push(U.kstDateStartUtc(String(req.query.from))); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = get(`SELECT COUNT(*) n FROM audit_logs l ${where}`, ...params).n;
  const items = all(`SELECT l.*, c.code AS course_code, c.title AS course_title, c.cohort_label FROM audit_logs l
    LEFT JOIN courses c ON c.id = l.course_id_optional ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`, ...params, size, offset)
    .map((x) => ({ ...x, changed_fields: x.changed_fields ? JSON.parse(x.changed_fields) : null }));
  res.json({ items, total, page, size });
});

module.exports = r;
