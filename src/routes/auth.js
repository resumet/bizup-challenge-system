'use strict';
const express = require('express');
const { get, run, tx, now } = require('../db');
const { E, normalizePhone, normalizeName, sha256, str } = require('../util');
const A = require('../auth');

const r = express.Router();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const STUDENT_FAIL = '로그인 정보를 확인해주세요. 등록한 이름과 전화번호를 입력해주세요.';
const STAFF_FAIL = '이메일 또는 비밀번호를 확인해주세요.';

r.post('/student/login', async (req, res) => {
  const name = normalizeName(str(req.body.name, 100));
  const phone = normalizePhone(str(req.body.phone, 40));
  const keys = ['ip:' + req.ip, 'stu:' + (phone || String(req.body.phone || '').slice(0, 40))];
  A.checkLoginRate(keys);
  const st = phone ? get(`SELECT s.*, c.password_hash, c.credential_version FROM students s
      JOIN student_credentials c ON c.student_id = s.id WHERE s.normalized_phone = ?`, phone) : null;
  const ok = await A.verifyPassword(phone || 'x', st ? st.password_hash : A.DUMMY_HASH.STUDENT);
  if (!st || !ok || st.normalized_name !== name || st.status !== 'ACTIVE') {
    A.recordLoginFailure(keys);
    await sleep(A.failureDelay(keys));
    throw new (require('../util').AppError)(401, 'LOGIN_FAILED', STUDENT_FAIL);
  }
  A.clearLoginFailures(keys);
  A.createSession(res, 'STUDENT', st.id, st.credential_version);
  res.json({ ok: true });
});

r.post('/staff/login', async (req, res) => {
  const email = String(str(req.body.email, 200) || '').trim().toLowerCase();
  const password = String(str(req.body.password, 200) || '');
  const keys = ['ip:' + req.ip, 'staff:' + email];
  A.checkLoginRate(keys);
  const a = email ? get('SELECT * FROM staff_accounts WHERE email = ?', email) : null;
  const ok = await A.verifyPassword(password, a && a.password_hash ? a.password_hash : A.DUMMY_HASH.STAFF);
  if (!a || !ok || a.status !== 'ACTIVE') {
    A.recordLoginFailure(keys);
    await sleep(A.failureDelay(keys));
    throw new (require('../util').AppError)(401, 'LOGIN_FAILED', STAFF_FAIL);
  }
  A.clearLoginFailures(keys);
  run('UPDATE staff_accounts SET last_login_at = ? WHERE id = ?', now(), a.id);
  A.createSession(res, 'STAFF', a.id, a.credential_version);
  res.json({ ok: true });
});

r.post('/logout', (req, res) => {
  if (req.session) run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), req.session.id);
  res.clearCookie(A.COOKIE, { path: '/' });
  res.json({ ok: true });
});

function loadToken(token) {
  const t = get('SELECT * FROM staff_tokens WHERE token_hash = ?', sha256(String(token || '')));
  if (!t || t.used_at || t.revoked_at || Date.parse(t.expires_at) <= Date.now()) {
    throw E.invalid('설정 링크가 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청해주세요.');
  }
  return t;
}
r.get('/staff/setup/:token', (req, res) => {
  const t = loadToken(req.params.token);
  const a = get('SELECT email, name, status FROM staff_accounts WHERE id = ?', t.staff_id);
  res.json({ email: a.email, name: a.name, purpose: t.purpose, expires_at: t.expires_at });
});
function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) throw E.invalid('비밀번호는 8자 이상 128자 이하로 입력해주세요.');
}
r.post('/staff/setup', async (req, res) => {
  const { token, password } = req.body;
  checkPasswordPolicy(password);
  loadToken(token);
  const hash = await A.hashPassword(password, 'STAFF');
  tx(() => {
    const t = loadToken(token); // 해시 계산 중 다른 요청이 사용했는지 재확인
    const a = get('SELECT * FROM staff_accounts WHERE id = ?', t.staff_id);
    run(`UPDATE staff_accounts SET password_hash = ?, status = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = ?`,
      hash, a.status === 'PENDING' ? 'ACTIVE' : a.status, now(), a.id);
    run('UPDATE staff_tokens SET used_at = ? WHERE id = ?', now(), t.id);
    A.revokeSubjectSessions('STAFF', a.id);
    A.audit({ user: { type: 'STAFF', id: a.id, name: a.name } }, { targetType: 'STAFF', targetId: a.id, action: 'PASSWORD_SET' });
  });
  res.json({ ok: true });
});
r.post('/staff/password', A.requireStaff, async (req, res) => {
  const { current_password: cur, new_password: next } = req.body;
  checkPasswordPolicy(next);
  const a = get('SELECT * FROM staff_accounts WHERE id = ?', req.user.id);
  if (!(await A.verifyPassword(String(cur || ''), a.password_hash))) throw E.invalid('현재 비밀번호가 일치하지 않습니다.');
  const hash = await A.hashPassword(next, 'STAFF');
  tx(() => {
    run('UPDATE staff_accounts SET password_hash = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = ?', hash, now(), a.id);
    A.revokeSubjectSessions('STAFF', a.id);
    A.audit(req, { targetType: 'STAFF', targetId: a.id, action: 'PASSWORD_CHANGED' });
  });
  res.clearCookie(A.COOKIE, { path: '/' });
  res.json({ ok: true, relogin: true });
});

module.exports = r;
