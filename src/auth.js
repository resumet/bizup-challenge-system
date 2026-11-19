'use strict';
const crypto = require('crypto');
const { get, all, run, uuid, now } = require('./db');
const { E, AppError, sha256, randomToken, serverNow } = require('./util');

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
// 존재하지 않는 계정에서도 비슷한 연산 시간을 소비하기 위한 더미 해시 (콜드 스타트 시 최초 1회 계산)
const dummyCache = {};
function dummyHash(profile) {
  if (!dummyCache[profile]) dummyCache[profile] = hashPassword('dummy-password-for-timing', profile);
  return dummyCache[profile];
}

// 5.4 세션 기본값 (운영 설정값)
const H = 3600 * 1000;
const SESSION_CFG = {
  STUDENT: { max: Number(process.env.STUDENT_SESSION_MAX_H || 24 * 7) * H, idle: Number(process.env.STUDENT_SESSION_IDLE_H || 24) * H },
  STAFF: { max: Number(process.env.STAFF_SESSION_MAX_H || 12) * H, idle: Number(process.env.STAFF_SESSION_IDLE_H || 2) * H },
};
const COOKIE = 'sid';
// Vercel 등 HTTPS 배포 환경에서는 기본으로 Secure 쿠키를 사용한다.
const SECURE_COOKIE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : !!process.env.VERCEL;

async function createSession(res, subjectType, subjectId, credentialVersion) {
  const token = randomToken(32);
  const t = Date.now();
  const cfg = SESSION_CFG[subjectType];
  await run(`INSERT INTO sessions(id, token_hash, csrf_token, subject_type, subject_id, credential_version, created_at, last_seen_at, expires_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
  uuid(), sha256(token), randomToken(24), subjectType, subjectId, credentialVersion,
  new Date(t).toISOString(), new Date(t).toISOString(), new Date(t + cfg.max).toISOString());
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, path: '/', maxAge: cfg.max });
}
async function revokeSubjectSessions(subjectType, subjectId) {
  await run('UPDATE sessions SET revoked_at = ? WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL', now(), subjectType, subjectId);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) {
      try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_) { /* ignore malformed */ }
    }
  });
  return out;
}

async function loadSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = await get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!s || s.revoked_at) return null;
  const t = Date.now();
  const cfg = SESSION_CFG[s.subject_type];
  if (Date.parse(s.expires_at) <= t || Date.parse(s.last_seen_at) + cfg.idle <= t) return null;
  let user;
  if (s.subject_type === 'STUDENT') {
    const st = await get(`SELECT s.id, s.code, s.name, s.status, c.credential_version FROM students s
                    JOIN student_credentials c ON c.student_id = s.id WHERE s.id = ?`, s.subject_id);
    if (!st || st.status !== 'ACTIVE' || st.credential_version !== s.credential_version) return null;
    user = { type: 'STUDENT', id: st.id, code: st.code, name: st.name };
  } else {
    const a = await get('SELECT * FROM staff_accounts WHERE id = ?', s.subject_id);
    if (!a || a.status !== 'ACTIVE' || a.credential_version !== s.credential_version) return null;
    const roles = (await all('SELECT role FROM staff_roles WHERE staff_id = ? ORDER BY role', a.id)).map((r) => r.role);
    const ins = await get('SELECT id, code FROM instructors WHERE staff_id = ?', a.id);
    user = {
      type: 'STAFF', id: a.id, name: a.name, email: a.email, roles,
      isAdmin: roles.includes('ADMIN'),
      instructorId: roles.includes('INSTRUCTOR') && ins ? ins.id : null,
      instructorCode: ins ? ins.code : null,
    };
  }
  if (t - Date.parse(s.last_seen_at) > 60 * 1000) {
    await run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date(t).toISOString(), s.id);
  }
  return { session: s, user };
}

const SESSION_FREE_PATHS = new Set(['/auth/student/login', '/auth/staff/login', '/auth/staff/setup']);
// 로그인·계정 설정 시 이 브라우저의 기존 세션을 종료한다(다른 계정 세션이 섞여 남지 않도록).
async function endCurrentSession(req, res, { keepCookie = false } = {}) {
  if (req.session) await run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), req.session.id);
  if (!keepCookie) res.clearCookie(COOKIE, { path: '/' }); // 로그인 시에는 새 세션 쿠키가 덮어쓴다
}
async function sessionMiddleware(req, res, next) {
  const r = await loadSession(req);
  req.session = r ? r.session : null;
  req.user = r ? r.user : null;
  // CSRF: 쿠키 기반 변경 요청은 세션별 토큰 헤더를 요구한다.
  // 로그인·계정 설정은 기존 세션을 사용하지 않고 오히려 교체하므로 검사하지 않는다
  // (설정 링크를 연 브라우저에 다른 계정의 세션이 남아 있어도 진행되도록).
  if (req.session && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !SESSION_FREE_PATHS.has(req.path)) {
    if (req.get('x-csrf-token') !== req.session.csrf_token) {
      throw new AppError(403, 'CSRF', '보안 토큰이 유효하지 않습니다. 페이지를 새로고침해주세요.');
    }
  }
  next();
}
const requireUser = (req, _res, next) => next(req.user ? undefined : E.unauth());
const requireStaff = (req, _res, next) => next(!req.user ? E.unauth() : req.user.type !== 'STAFF' ? E.notFound() : undefined);
const requireAdmin = (req, _res, next) => next(!req.user ? E.unauth() : !(req.user.type === 'STAFF' && req.user.isAdmin) ? E.forbidden() : undefined);
const requireStudent = (req, _res, next) => next(!req.user ? E.unauth() : req.user.type !== 'STUDENT' ? E.notFound() : undefined);

// 17장: 반복 시도 제한 (IP·계정 식별값, 단계적 지연). 서버리스 인스턴스 간 공유를 위해 DB에 저장한다.
const WINDOW = 15 * 60 * 1000;
const MAX_FAIL = Number(process.env.LOGIN_MAX_FAILURES || 10);
const rateKey = (k) => sha256('login:' + k); // 전화번호 등 식별값을 평문으로 남기지 않는다
async function failCount(key) {
  const r = await get('SELECT * FROM login_attempts WHERE key = ?', rateKey(key));
  if (!r || Date.now() - Date.parse(r.first_at) > WINDOW) return 0;
  return r.fails;
}
async function checkLoginRate(keys) {
  for (const k of keys) if ((await failCount(k)) >= MAX_FAIL) throw E.rate('로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.');
}
async function recordLoginFailure(keys) {
  const t = now(); const cutoff = new Date(Date.now() - WINDOW).toISOString();
  for (const k of keys) {
    await run(`INSERT INTO login_attempts(key, first_at, fails) VALUES(?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET fails = CASE WHEN login_attempts.first_at < ? THEN 1 ELSE login_attempts.fails + 1 END,
        first_at = CASE WHEN login_attempts.first_at < ? THEN excluded.first_at ELSE login_attempts.first_at END`, rateKey(k), t, cutoff, cutoff);
  }
}
async function clearLoginFailures(keys) { for (const k of keys) await run('DELETE FROM login_attempts WHERE key = ?', rateKey(k)); }
async function failureDelay(keys) {
  let f = 0;
  for (const k of keys) f = Math.max(f, await failCount(k));
  return Math.min(f * 200, 2000);
}

// 감사 이력
async function audit(req, { courseId = null, targetType, targetId = null, action, changed = null, reason = null, restricted = false }) {
  const u = req && req.user;
  await run(`INSERT INTO audit_logs(actor_type, actor_id, actor_name, course_id_optional, target_type, target_id, action, changed_fields, reason, restricted, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  u ? u.type : 'SYSTEM', u ? u.id : null, u ? u.name : null, courseId, targetType, targetId, action,
  changed ? JSON.stringify(changed) : null, reason, restricted ? 1 : 0, serverNow().toISOString());
}

module.exports = {
  hashPassword, verifyPassword, dummyHash, createSession, endCurrentSession, revokeSubjectSessions, sessionMiddleware,
  requireUser, requireStaff, requireAdmin, requireStudent, checkLoginRate, recordLoginFailure,
  clearLoginFailures, failureDelay, audit, COOKIE, SECURE_COOKIE,
};
