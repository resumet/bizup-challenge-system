'use strict';
// 최초 관리자 계정 초기화 (5.2: 외부 공개 관리자 가입 기능 없음)
// 사용: npm run init-admin -- --email admin@example.com --name 관리자 [--password 비밀번호]
const { get, run, uuid, now } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { sha256, randomToken } = require('../src/util');

(async () => {
  const args = {};
  process.argv.slice(2).forEach((a, i, arr) => { if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1]; });
  const email = String(args.email || '').trim().toLowerCase();
  const name = args.name || '관리자';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('--email 을 올바르게 입력해주세요.'); process.exit(1); }
  if (args.password && args.password.length < 8) { console.error('비밀번호는 8자 이상이어야 합니다.'); process.exit(1); }
  let a = get('SELECT * FROM staff_accounts WHERE email = ?', email);
  const t = now();
  if (!a) {
    const id = uuid();
    run(`INSERT INTO staff_accounts(id, email, name, status, created_at, updated_at) VALUES(?,?,?,?,?,?)`, id, email, name, 'PENDING', t, t);
    a = get('SELECT * FROM staff_accounts WHERE id = ?', id);
  }
  run(`INSERT OR IGNORE INTO staff_roles(staff_id, role) VALUES(?, 'ADMIN')`, a.id);
  if (args.password) {
    run(`UPDATE staff_accounts SET password_hash = ?, status = 'ACTIVE', credential_version = credential_version + 1, updated_at = ? WHERE id = ?`,
      await hashPassword(args.password, 'STAFF'), t, a.id);
    console.log(`관리자 계정이 준비되었습니다: ${email}`);
  } else {
    const token = randomToken(32);
    run('UPDATE staff_tokens SET revoked_at = ? WHERE staff_id = ? AND used_at IS NULL AND revoked_at IS NULL', t, a.id);
    run(`INSERT INTO staff_tokens(id, staff_id, token_hash, purpose, expires_at, created_at) VALUES(?,?,?,?,?,?)`,
      uuid(), a.id, sha256(token), 'SETUP', new Date(Date.now() + 24 * 3600 * 1000).toISOString(), t);
    console.log(`관리자 계정 설정 링크 (24시간 유효, 1회용):\n  http://localhost:${process.env.PORT || 3000}/#/setup/${token}`);
  }
  run(`INSERT INTO audit_logs(actor_type, target_type, target_id, action, created_at) VALUES('SYSTEM','STAFF',?,'ADMIN_INITIALIZED',?)`, a.id, t);
})();
