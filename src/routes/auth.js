'use strict';
const express = require('express');
const { get, run, tx, now } = require('../db');
const { E, AppError, normalizePhone, normalizeName, sha256, str } = require('../util');
const A = require('../auth');

const r = express.Router();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const STUDENT_FAIL = '로그인 정보를 확인해주세요. 등록한 이름과 전화번호를 입력해주세요.';
const STAFF_FAIL = '이메일 또는 비밀번호를 확인해주세요.';

r.post('/student/login', async (req, res) => {
  const name = normalizeName(str(req.body.name, 100));
  const phone = normalizePhone(str(req.body.phone, 40));
  const keys = ['ip:' + req.ip, 'stu:' + (phone || String(req.body.phone || '').slice(0, 40))];
  await A.checkLoginRate(keys);
  const st = phone ? await get(`SELECT s.*, c.password_hash, c.credential_version FROM students s
      JOIN student_credentials c ON c.student_id = s.id WHERE s.normalized_phone = ?`, phone) : null;
  const ok = await A.verifyPassword(phone || 'x', st ? st.password_hash : await A.dummyHash('STUDENT'));
  if (!st || !ok || st.normalized_name !== name || st.status !== 'ACTIVE') {
    await A.recordLoginFailure(keys);
    await sleep(await A.failureDelay(keys));
    throw new AppError(401, 'LOGIN_FAILED', STUDENT_FAIL);
  }
  await A.clearLoginFailures(keys);
  await A.createSession(res, 'STUDENT', st.id, st.credential_version);
  res.json({ ok: true });
});

r.post('/staff/login', async (req, res) => {
  const email = String(str(req.body.email, 200) || '').trim().toLowerCase();
  const password = String(str(req.body.password, 200) || '');
  const keys = ['ip:' + req.ip, 'staff:' + email];
  await A.checkLoginRate(keys);
  const a = email ? await get('SELECT * FROM staff_accounts WHERE email = ?', email) : null;
  const ok = await A.verifyPassword(password, a && a.password_hash ? a.password_hash : await A.dummyHash('STAFF'));
  if (!a || !ok || a.status !== 'ACTIVE') {
    await A.recordLoginFailure(keys);
    await sleep(await A.failureDelay(keys));
    throw new AppError(401, 'LOGIN_FAILED', STAFF_FAIL);
  }
  await A.clearLoginFailures(keys);
  await run('UPDATE staff_accounts SET last_login_at = ? WHERE id = ?', now(), a.id);
  await A.createSession(res, 'STAFF', a.id, a.credential_version);
  res.json({ ok: true });
});

r.post('/logout', async (req, res) => {
  if (req.session) await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', now(), req.session.id);
  res.clearCookie(A.COOKIE, { path: '/' });
  res.json({ ok: true });
});

async function loadToken(token, lock) {
  const t = await get('SELECT * FROM staff_tokens WHERE token_hash = ?' + (lock ? ' FOR UPDATE' : ''), sha256(String(token || '')));
  if (!t || t.used_at || t.revoked_at || Date.parse(t.expires_at) <= Date.now()) {
    throw E.invalid('설정 링크가 만료되었거나 이미 사용되었습니다. 관리자에게 새 링크를 요청해주세요.');
  }
  return t;
}
r.get('/staff/setup/:token', async (req, res) => {
  const t = await loadToken(req.params.token);
  const a = await get('SELECT email, name, status FROM staff_accounts WHERE id = ?', t.staff_id);
  res.json({ email: a.email, name: a.name, purpose: t.purpose, expires_at: t.expires_at });
});
function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) throw E.invalid('비밀번호는 8자 이상 128자 이하로 입력해주세요.');
}
r.post('/staff/setup', async (req, res) => {
  const { token, password } = req.body;
  checkPasswordPolicy(password);
  await loadToken(token);
  const hash = await A.hashPassword(password, 'STAFF');
  await tx(async () => {
    const t = await loadToken(token, true); // 해시 계산 중 다른 요청이 사용했는지 잠금 후 재확인
    const a = await get('SELECT * FROM staff_accounts WHERE id = ?', t.staff_id);
    await run(`UPDATE staff_accounts SET password_hash = ?, status = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = ?`,
      hash, a.status === 'PENDING' ? 'ACTIVE' : a.status, now(), a.id);
    await run('UPDATE staff_tokens SET used_at = ? WHERE id = ?', now(), t.id);
    await A.revokeSubjectSessions('STAFF', a.id);
    await A.audit({ user: { type: 'STAFF', id: a.id, name: a.name } }, { targetType: 'STAFF', targetId: a.id, action: 'PASSWORD_SET' });
  });
  res.json({ ok: true });
});
r.post('/staff/password', A.requireStaff, async (req, res) => {
  const { current_password: cur, new_password: next } = req.body;
  checkPasswordPolicy(next);
  const a = await get('SELECT * FROM staff_accounts WHERE id = ?', req.user.id);
  if (!(await A.verifyPassword(String(cur || ''), a.password_hash))) throw E.invalid('현재 비밀번호가 일치하지 않습니다.');
  const hash = await A.hashPassword(next, 'STAFF');
  await tx(async () => {
    await run('UPDATE staff_accounts SET password_hash = ?, credential_version = credential_version + 1, updated_at = ? WHERE id = ?', hash, now(), a.id);
    await A.revokeSubjectSessions('STAFF', a.id);
    await A.audit(req, { targetType: 'STAFF', targetId: a.id, action: 'PASSWORD_CHANGED' });
  });
  res.clearCookie(A.COOKIE, { path: '/' });
  res.json({ ok: true, relogin: true });
});

module.exports = r;
