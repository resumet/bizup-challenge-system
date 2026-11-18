'use strict';
const crypto = require('crypto');
const { get, all, run, uuid, now } = require('./db');
const { E, sha256, randomToken, serverNow } = require('./util');

// 17장: 비밀번호 전용 해시 + 개별 salt (scrypt).
// 운영자: OWASP 권장 N=2^17. 학생: 전화번호 파생 고정값이라 엔트로피 자체가 낮고(5.3 제약),
// 명단 대량 등록 시간을 고려해 N=2^15 사용. 파라미터는 해시 문자열에 함께 저장한다.
const MAXMEM = 256 * 1024 * 1024;
const PROFILES = {
  STAFF: { N: Number(process.env.STAFF_SCRYPT_N || 131072), r: 8, p: 1 },
  STUDENT: { N: Number(process.env.STUDENT_SCRYPT_N || 32768), r: 8, p: 1 },
};
function scryptAsync(pw, salt, len, opts) {
  return new Promise((resolve, reject) => crypto.scrypt(pw, salt, len, { ...opts, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))));
}
async function hashPassword(pw, profile = 'STAFF') {
  const P = PROFILES[profile];
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(pw), salt, 32, P);
  return `scrypt$${P.N}$${P.r}$${P.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, N, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(String(pw), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}
// 존재하지 않는 계정에서도 비슷한 연산 시간을 소비하기 위한 더미 해시
const DUMMY_HASH = {};
(async () => {
  DUMMY_HASH.STAFF = await hashPassword('dummy-password-for-timing', 'STAFF');
  DUMMY_HASH.STUDENT = await hashPassword('dummy-password-for-timing', 'STUDENT');
})();

// 5.4 세션 기본값 (운영 설정값)
const H = 3600 * 1000;
const SESSION_CFG = {
  STUDENT: { max: Number(process.env.STUDENT_SESSION_MAX_H || 24 * 7) * H, idle: Number(process.env.STUDENT_SESSION_IDLE_H || 24) * H },
  STAFF: { max: Number(process.env.STAFF_SESSION_MAX_H || 12) * H, idle: Number(process.env.STAFF_SESSION_IDLE_H || 2) * H },
};
const COOKIE = 'sid';
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';

function createSession(res, subjectType, subjectId, credentialVersion) {
  const token = randomToken(32);
  const t = Date.now();
  const cfg = SESSION_CFG[subjectType];
  run(`INSERT INTO sessions(id, token_hash, csrf_token, subject_type, subject_id, credential_version, created_at, last_seen_at, expires_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    uuid(), sha256(token), randomToken(24), subjectType, subjectId, credentialVersion,
    new Date(t).toISOString(), new Date(t).toISOString(), new Date(t + cfg.max).toISOString());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, path: '/', maxAge: cfg.max });
}
function revokeSubjectSessions(subjectType, subjectId) {
  run('UPDATE sessions SET revoked_at = ? WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL', now(), subjectType, subjectId);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!s || s.revoked_at) return null;
  const t = Date.now();
  const cfg = SESSION_CFG[s.subject_type];
  if (Date.parse(s.expires_at) <= t || Date.parse(s.last_seen_at) + cfg.idle <= t) return null;
  let user;
  if (s.subject_type === 'STUDENT') {
    const st = get(`SELECT s.id, s.code, s.name, s.status, c.credential_version FROM students s
                    JOIN student_credentials c ON c.student_id = s.id WHERE s.id = ?`, s.subject_id);
    if (!st || st.status !== 'ACTIVE' || st.credential_version !== s.credential_version) return null;
    user = { type: 'STUDENT', id: st.id, code: st.code, name: st.name };
  } else {
    const a = get('SELECT * FROM staff_accounts WHERE id = ?', s.subject_id);
    if (!a || a.status !== 'ACTIVE' || a.credential_version !== s.credential_version) return null;
    const roles = all('SELECT role FROM staff_roles WHERE staff_id = ?', a.id).map((r) => r.role);
    const ins = get('SELECT id, code FROM instructors WHERE staff_id = ?', a.id);
    user = {
      type: 'STAFF', id: a.id, name: a.name, email: a.email, roles,
      isAdmin: roles.includes('ADMIN'),
      instructorId: roles.includes('INSTRUCTOR') && ins ? ins.id : null,
      instructorCode: ins ? ins.code : null,
    };
  }
  if (t - Date.parse(s.last_seen_at) > 60 * 1000) {
    run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date(t).toISOString(), s.id);
  }
  return { session: s, user };
}

function sessionMiddleware(req, res, next) {
  const r = loadSession(req);
  req.session = r ? r.session : null;
  req.user = r ? r.user : null;
  // CSRF: 쿠키 기반 변경 요청은 세션별 토큰 헤더를 요구한다.
  if (req.session && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.get('x-csrf-token') !== req.session.csrf_token) {
      return next(E.forbidden('보안 토큰이 유효하지 않습니다. 페이지를 새로고침해주세요.'));
    }
  }
  next();
}
const requireUser = (req, _res, next) => next(req.user ? undefined : E.unauth());
const requireStaff = (req, _res, next) => next(!req.user ? E.unauth() : req.user.type !== 'STAFF' ? E.notFound() : undefined);
const requireAdmin = (req, _res, next) => next(!req.user ? E.unauth() : !(req.user.type === 'STAFF' && req.user.isAdmin) ? E.forbidden() : undefined);
const requireStudent = (req, _res, next) => next(!req.user ? E.unauth() : req.user.type !== 'STUDENT' ? E.notFound() : undefined);

// 17장: 반복 시도 제한 (IP·계정 식별값, 단계적 지연)
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAIL = Number(process.env.LOGIN_MAX_FAILURES || 10);
function rateKeyState(key) {
  const t = Date.now();
  let s = attempts.get(key);
  if (!s || t - s.first > WINDOW) { s = { first: t, fails: 0 }; attempts.set(key, s); }
  return s;
}
function checkLoginRate(keys) {
  for (const k of keys) if (rateKeyState(k).fails >= MAX_FAIL) throw E.rate('로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.');
}
function recordLoginFailure(keys) { keys.forEach((k) => { rateKeyState(k).fails++; }); }
function clearLoginFailures(keys) { keys.forEach((k) => attempts.delete(k)); }
function failureDelay(keys) {
  const f = Math.max(...keys.map((k) => rateKeyState(k).fails));
  return Math.min(f * 200, 2000);
}
function resetRateLimits() { attempts.clear(); }

// 감사 이력
function audit(req, { courseId = null, targetType, targetId = null, action, changed = null, reason = null, restricted = false }) {
  const u = req && req.user;
  run(`INSERT INTO audit_logs(actor_type, actor_id, actor_name, course_id_optional, target_type, target_id, action, changed_fields, reason, restricted, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    u ? u.type : 'SYSTEM', u ? u.id : null, u ? u.name : null, courseId, targetType, targetId, action,
    changed ? JSON.stringify(changed) : null, reason, restricted ? 1 : 0, serverNow().toISOString());
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, createSession, revokeSubjectSessions, sessionMiddleware,
  requireUser, requireStaff, requireAdmin, requireStudent, checkLoginRate, recordLoginFailure,
  clearLoginFailures, failureDelay, resetRateLimits, audit, COOKIE, SECURE_COOKIE,
};
