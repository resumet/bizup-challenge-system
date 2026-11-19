'use strict';
// PRD 20장 인수·검수 시나리오 기반 API 통합 테스트
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bizup-test-'));
process.env.DATA_DIR = TMP;
// 기본은 메모리 Postgres(PGlite). TEST_DATABASE_URL 을 주면 실제 Postgres(빈 DB)에서 실행한다(CI).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'pglite:';
delete process.env.SUPABASE_URL; // 테스트는 항상 로컬 파일 저장소 사용
process.env.STAFF_SCRYPT_N = '1024';
process.env.STUDENT_SCRYPT_N = '1024';
process.env.LOGIN_MAX_FAILURES = '1000';
process.env.ROSTER_API_ALLOW_PRIVATE = '1'; // 로컬 모의 API 서버 사용

const { get, run, uuid, now, close, migrate } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { setClockOffset } = require('../src/util');
const { createApp } = require('../src/server');
const { Client } = require('../scripts/client');

const DAY = 86400e3;
const kstDate = (offsetDays) => new Date(Date.now() + 9 * 3600e3 + offsetDays * DAY).toISOString().slice(0, 10);
let server; let base; let admin;
const C = () => new Client(base);
const ok = (r, what = '') => { assert.ok(r.status < 300, `${what} ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

async function mkInstructor(email, name) {
  const r = ok(await admin.post('/api/staff', { email, name, roles: ['INSTRUCTOR'] }));
  ok(await C().post('/api/auth/staff/setup', { token: r.setup_path.split('/').pop(), password: 'password123' }));
  const c = C(); ok(await c.staffLogin(email, 'password123'));
  return { client: c, id: r.staff.instructor_id, staffId: r.staff.id };
}
async function mkCourse(title, cohort, insIds = []) {
  return ok(await admin.post('/api/courses', { title, cohort_label: cohort, state: insIds.length ? 'ACTIVE' : 'READY', instructor_ids: insIds, confirm_duplicate: true }));
}
async function enroll(courseId, name, phone) { return ok(await admin.post(`/api/courses/${courseId}/enrollments`, { name, phone })); }
async function mkChallenge(courseId, opts = {}) {
  return ok(await admin.post(`/api/courses/${courseId}/challenges`, { title: '챌린지', start_date: kstDate(-1), end_date: kstDate(10), visibility: 'PUBLISHED', ...opts }));
}
async function mkAssignment(chId, { items = ['할 일 1', '할 일 2'], required = false, publish = true } = {}) {
  const a = ok(await admin.post(`/api/challenges/${chId}/assignments`, { title: '과제', items: items.map((t) => ({ title: t })), submission_required: required }));
  if (publish) ok(await admin.post(`/api/assignments/${a.id}/publish`));
  return a;
}
async function student(name, phone) { const c = C(); ok(await c.studentLogin(name, phone), 'student login'); return c; }
async function preview(client, courseId, name, buf) {
  const f = await client.uploadFile(name, buf, 'roster');
  if (f.status !== 200) return f;
  return client.post(`/api/courses/${courseId}/imports/preview`, { file_id: f.data.id });
}
const check = (c, a, item, v = true) => c.put(`/api/me/assignments/${a.id}/items/${item.id}`, { is_checked: v });

test.before(async () => {
  await migrate(); // 실제 Postgres일 때 스키마 적용 (PGlite는 자동)
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const id = uuid();
  (await run(`INSERT INTO staff_accounts(id, email, name, password_hash, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`, id, 'admin@t.com', '관리자', await hashPassword('adminpass1'), 'ACTIVE', now(), now()));
  (await run(`INSERT INTO staff_roles(staff_id, role) VALUES(?, 'ADMIN')`, id));
  admin = C(); ok(await admin.staffLogin('admin@t.com', 'adminpass1'));
});
test.after(async () => { server.close(); await close(); });
test.afterEach(() => setClockOffset(0));

test('AT-01/02 기수별 별도 강의, 공동 강사 권한 범위', async () => {
  const i1 = await mkInstructor('i1@t.com', '강사1'); const i2 = await mkInstructor('i2@t.com', '강사2');
  const c1 = await mkCourse('블로그', '1기', [i1.id, i2.id]); const c2 = await mkCourse('블로그', '2기');
  assert.notEqual(c1.id, c2.id); assert.notEqual(c1.code, c2.code);
  ok(await i1.client.get(`/api/courses/${c1.id}`)); ok(await i2.client.get(`/api/courses/${c1.id}`));
  assert.equal((await i1.client.get(`/api/courses/${c2.id}`)).status, 404);
  const dup = await admin.post('/api/courses', { title: '블로그', cohort_label: '1기' });
  assert.equal(dup.status, 409); assert.equal(dup.data.error.reason, 'POSSIBLE_DUPLICATE');
});

test('AT-03/04/05/06 전화번호 기준 학생 단일화·정규화·동명이인·충돌', async () => {
  const c1 = await mkCourse('A', '1기'); const c2 = await mkCourse('B', '1기');
  const r1 = await enroll(c1.id, '홍길동', '010-2000-0001');
  const r2 = await enroll(c2.id, '홍길동', '+82 10 2000 0001');
  assert.equal(r1.student.id, r2.student.id);
  assert.equal((await get('SELECT COUNT(*) AS n FROM enrollments WHERE student_id = ?', r1.student.id)).n, 2);
  await enroll(c1.id, '홍길동', '01020000002');
  await student('홍길동', '010 2000 0001'); await student('홍길동', '01020000002');
  const conflict = await admin.post(`/api/courses/${c2.id}/enrollments`, { name: '김철수', phone: '01020000001' });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error.reason, 'NAME_CONFLICT');
  assert.equal((await get('SELECT name FROM students WHERE id = ?', r1.student.id)).name, '홍길동');
  const bad = await C().studentLogin('홍길동', '01099999999');
  assert.equal(bad.status, 401);
  const bad2 = await C().studentLogin('없는사람', '01020000001');
  assert.equal(bad2.data.error.message, bad.data.error.message);
});

test('AT-07/08/09 명단 업로드: 미리보기 무생성, 재업로드 중복 없음, 비활성 재활성화 필요', async () => {
  const c = await mkCourse('업로드', '1기');
  const csv = '﻿이름,전화번호,수강 등록 메모\n가나다,010-3000-0001,메모1\n라마바,01030000002,\n가나다,01030000001,\n사아자,1030000003,\n,01030000004,\n';
  const p = ok(await preview(admin, c.id, 'list.csv', Buffer.from(csv)));
  assert.equal((await get('SELECT COUNT(*) AS n FROM students WHERE normalized_phone LIKE ?', '0103000%')).n, 0);
  const cls = p.rows.map((r) => r.classification);
  assert.deepEqual(cls, ['NEW', 'NEW', 'DUP_IN_FILE', 'ERROR', 'ERROR']);
  assert.match(p.rows[3].error, /텍스트/);
  ok(await admin.post(`/api/imports/${p.id}/commit`, { idempotency_key: p.id }));
  let job;
  for (let i = 0; i < 50; i++) { job = ok(await admin.post(`/api/imports/${p.id}/commit`, {})); if (job.state === 'COMMITTED') break; }
  assert.equal(job.state, 'COMMITTED'); assert.equal(job.result_counts.created, 2);
  const again = ok(await admin.post(`/api/imports/${p.id}/commit`, {}));
  assert.equal(again.state, 'COMMITTED');
  const enr = (await get(`SELECT e.id FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ? AND s.normalized_phone = '01030000001'`, c.id));
  ok(await admin.patch(`/api/enrollments/${enr.id}/status`, { status: 'INACTIVE', reason: '환불' }));
  const p2 = ok(await preview(admin, c.id, 'list.csv', Buffer.from(csv)));
  assert.equal(p2.rows[0].classification, 'NEEDS_REACTIVATION');
  assert.equal(p2.rows[1].classification, 'ALREADY_ENROLLED');
  assert.equal((await get('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', c.id)).n, 2);
});

test('AT-10/11/12/14 로그인 구분, 로그인 정보 조회 이력, 담당 외 강의 명단 접근 거부', async () => {
  const i = await mkInstructor('i3@t.com', '강사3');
  const c = await mkCourse('로그인', '1기', [i.id]);
  const r = await enroll(c.id, '정보', '01040000001');
  const s = await student('정보', '01040000001');
  assert.equal((await s.get('/api/courses')).status, 404);
  assert.equal((await s.post('/api/auth/staff/password', {})).status, 404);
  const list = ok(await i.client.get(`/api/courses/${c.id}/enrollments`));
  assert.match(list.items[0].student.phone, /\*{4}/);
  const rv = ok(await i.client.post(`/api/enrollments/${r.enrollment_id}/login-info/reveal`));
  assert.equal(rv.login_password, '01040000001');
  assert.ok((await get(`SELECT 1 AS ok FROM audit_logs WHERE action = 'LOGIN_INFO_REVEALED' AND actor_id = ?`, i.staffId)));
  ok(await admin.patch(`/api/enrollments/${r.enrollment_id}/status`, { status: 'INACTIVE', reason: '중도탈퇴' }));
  assert.equal((await i.client.post(`/api/enrollments/${r.enrollment_id}/login-info/reveal`)).status, 403);
  const other = await mkCourse('로그인', '2기');
  assert.equal((await preview(i.client, other.id, 'a.csv', Buffer.from('이름,전화번호\n'))).status, 404);
  assert.equal((await i.client.post(`/api/courses/${other.id}/enrollments`, { name: 'x', phone: '01040000009' })).status, 404);
});

test('AT-13 전화번호 정정: ID 유지, 중복 거부, 세션 취소', async () => {
  const c = await mkCourse('정정', '1기');
  const a = await enroll(c.id, '정정', '01050000001'); await enroll(c.id, '다른', '01050000002');
  const s = await student('정정', '01050000001');
  const dupe = await admin.patch(`/api/students/${a.student.id}`, { phone: '01050000002', reason: '오류' });
  assert.equal(dupe.status, 409);
  ok(await admin.patch(`/api/students/${a.student.id}`, { phone: '010-5000-0003', reason: '입력 오류' }));
  assert.equal((await s.get('/api/me/courses')).status, 401);
  const s2 = await student('정정', '01050000003');
  const me = ok(await s2.get('/api/me/profile')); assert.equal(me.code, a.student.code);
});

test('AT-15~21 챌린지·과제 공개·동결', async () => {
  const c = await mkCourse('과제', '1기');
  await enroll(c.id, '선발', '01060000001');
  const ch = await mkChallenge(c.id); const ch2 = await mkChallenge(c.id, { title: '두번째' });
  assert.notEqual(ch.id, ch2.id);
  const empty = ok(await admin.post(`/api/challenges/${ch.id}/assignments`, { title: '빈 과제', items: [] }));
  const pub = await admin.post(`/api/assignments/${empty.id}/publish`);
  assert.equal(pub.status, 400); assert.match(pub.data.error.message, /1개 이상/);
  const a = await mkAssignment(ch.id);
  await enroll(c.id, '후발', '01060000002');
  const late = await student('후발', '01060000002');
  const detail = ok(await late.get(`/api/me/courses/${c.id}`));
  assert.equal(detail.challenges.find((x) => x.id === ch.id).assignments.length, 1);
  const s = await student('선발', '01060000001');
  ok(await check(s, a, a.items[0]));
  let cur = ok(await admin.get(`/api/assignments/${a.id}`));
  assert.ok(cur.locked_at);
  ok(await check(s, a, a.items[0], false));
  cur = ok(await admin.get(`/api/assignments/${a.id}`)); assert.ok(cur.locked_at);
  const ch1 = await admin.patch(`/api/assignments/${a.id}`, { version: cur.version, items: [...cur.items, { title: '추가' }] });
  assert.equal(ch1.status, 409); assert.equal(ch1.data.error.reason, 'ASSIGNMENT_LOCKED');
  const ch3 = await admin.patch(`/api/assignments/${a.id}`, { version: cur.version, submission_required: true });
  assert.equal(ch3.status, 409);
  const fix = ok(await admin.patch(`/api/assignments/${a.id}`, { version: cur.version, title: '과제(오탈자 수정)', items: cur.items }));
  assert.equal(fix.title, '과제(오탈자 수정)');
  assert.ok((await get(`SELECT 1 AS ok FROM audit_logs WHERE target_id = ? AND action = 'ASSIGNMENT_UPDATED_AFTER_LOCK'`, a.id)));
  const stale = await admin.patch(`/api/assignments/${a.id}`, { version: cur.version, title: 'x' });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.reason, 'VERSION_CONFLICT');
  assert.equal((await admin.post(`/api/assignments/${a.id}/unpublish`)).status, 409);
  assert.equal((await admin.del(`/api/assignments/${a.id}`)).status, 409);
});

test('AT-22/23/24 과제 복사: 새 초안, 독립 자료, 권한 검사', async () => {
  const i = await mkInstructor('i4@t.com', '강사4');
  const src = await mkCourse('원본', '1기'); const dst = await mkCourse('대상', '2기', [i.id]);
  const chS = await mkChallenge(src.id); const chD = await mkChallenge(dst.id);
  await enroll(src.id, '원본생', '01070000001'); await enroll(dst.id, '대상생', '01070000002');
  const a = await mkAssignment(chS.id, { required: true });
  const up = ok(await admin.uploadFile('guide.pdf', Buffer.from('%PDF-1.4 test')));
  ok(await admin.post(`/api/assignments/${a.id}/resources`, { type: 'FILE', file_id: up.id }));
  ok(await check(await student('원본생', '01070000001'), a, a.items[0]));
  assert.equal((await i.client.post(`/api/assignments/${a.id}/copy`, { target_challenge_id: chD.id })).status, 404);
  const key = 'copy-key-1';
  const cp = ok(await admin.post(`/api/assignments/${a.id}/copy`, { target_challenge_id: chD.id, idempotency_key: key }));
  const cp2 = ok(await admin.post(`/api/assignments/${a.id}/copy`, { target_challenge_id: chD.id, idempotency_key: key }));
  assert.equal(cp.id, cp2.id);
  assert.equal(cp.visibility, 'DRAFT'); assert.equal(cp.locked_at, null); assert.equal(cp.title, '과제 (복사)');
  assert.ok(cp.items.every((x) => !a.items.some((y) => y.id === x.id)));
  assert.equal(cp.submission_required, true);
  const resId = ok(await admin.get(`/api/assignments/${a.id}`)).resources[0].id;
  ok(await admin.del(`/api/resources/${resId}`));
  ok(await admin.post(`/api/assignments/${cp.id}/publish`));
  const ds = await student('대상생', '01070000002');
  const view = ok(await ds.get(`/api/me/assignments/${cp.id}`));
  assert.equal(view.resources.length, 1);
  const dl = await ds.get(`/api/files/${view.resources[0].file_id}/download`);
  assert.equal(dl.status, 200);
  ok(await i.client.patch(`/api/assignments/${cp.id}`, { version: ok(await i.client.get(`/api/assignments/${cp.id}`)).version, title: '강사 수정' }));
});

test('AT-26~33 자동 완료·제출 필수·완료 취소', async () => {
  const c = await mkCourse('완료', '1기');
  await enroll(c.id, '완료생', '01080000001');
  const ch = await mkChallenge(c.id);
  const opt = await mkAssignment(ch.id); const req = await mkAssignment(ch.id, { required: true });
  const s = await student('완료생', '01080000001');
  for (const it of opt.items) ok(await check(s, opt, it));
  let v = ok(await s.get(`/api/me/assignments/${opt.id}`)); assert.equal(v.status, 'COMPLETED');
  for (const it of req.items) ok(await check(s, req, it));
  v = ok(await s.get(`/api/me/assignments/${req.id}`)); assert.equal(v.status, 'NEED_SUBMISSION'); assert.ok(v.hint);
  const bad = await s.post(`/api/me/assignments/${req.id}/submissions`, { type: 'LINK', url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  const pending = ok(await s.uploadFile('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])));
  v = ok(await s.get(`/api/me/assignments/${req.id}`)); assert.equal(v.status, 'NEED_SUBMISSION'); // 업로드만 된 파일은 제출로 세지 않음
  const fake = await s.uploadFile('evil.pdf', Buffer.from('MZ not a pdf'));
  assert.equal(fake.status, 400);
  v = ok(await s.post(`/api/me/assignments/${req.id}/submissions`, { type: 'FILE', file_id: pending.id }));
  assert.equal(v.status, 'COMPLETED');
  const completedAt = v.completed_at;
  v = ok(await s.post(`/api/me/assignments/${req.id}/submissions`, { type: 'LINK', url: 'https://blog.example.com/1' }));
  assert.equal(v.completed_at, completedAt);
  v = ok(await s.del(`/api/me/submissions/${v.submissions[0].id}`)); assert.equal(v.status, 'COMPLETED');
  v = ok(await s.del(`/api/me/submissions/${v.submissions[0].id}`)); assert.equal(v.status, 'NEED_SUBMISSION');
  v = ok(await check(s, opt, opt.items[0], false)); assert.equal(v.status, 'IN_PROGRESS');
  const ev = (await get(`SELECT COUNT(*) AS n FROM progress_events pe JOIN task_progress tp ON tp.id = pe.task_progress_id WHERE tp.assignment_id = ? AND pe.event_type = 'UNCOMPLETED'`, opt.id)).n;
  assert.equal(ev, 1);
  const forged = await s.put(`/api/me/assignments/${opt.id}/items/${opt.items[0].id}`, { is_checked: 'true', is_completed: true });
  assert.equal(forged.status, 400);
});

test('AT-34~38 기간 경계·종료 후 정책·기한 구분 유지', async () => {
  const c = await mkCourse('기간', '1기');
  await enroll(c.id, '기간생', '01090000001');
  const today = kstDate(0);
  const future = await mkChallenge(c.id, { start_date: kstDate(2), end_date: kstDate(5) });
  const fa = await mkAssignment(future.id);
  const s = await student('기간생', '01090000001');
  const v0 = ok(await s.get(`/api/me/assignments/${fa.id}`));
  assert.equal(v0.can_act, false); assert.match(v0.notice, /시작일부터/);
  assert.equal((await check(s, fa, fa.items[0])).status, 409);
  const closed = await mkChallenge(c.id, { start_date: kstDate(-5), end_date: kstDate(-1) });
  const ca = await mkAssignment(closed.id);
  const r = await check(s, ca, ca.items[0]);
  assert.equal(r.status, 409); assert.match(r.data.error.message, /종료/);
  const open = await mkChallenge(c.id, { start_date: kstDate(-5), end_date: kstDate(-1), allow_after_deadline: true });
  const oa = await mkAssignment(open.id, { items: ['하나'] });
  const v = ok(await check(s, oa, oa.items[0]));
  assert.equal(v.status, 'COMPLETED_LATE');
  const cur = ok(await admin.get(`/api/assignments/${oa.id}`));
  const chg = await admin.patch(`/api/challenges/${open.id}`, { end_date: kstDate(10) });
  assert.equal(chg.status, 409); assert.equal(chg.data.error.reason, 'CONFIRM_SCHEDULE_CHANGE');
  ok(await admin.patch(`/api/challenges/${open.id}`, { end_date: kstDate(10), confirm_schedule_change: true }));
  assert.equal(ok(await s.get(`/api/me/assignments/${oa.id}`)).status, 'COMPLETED_LATE');
  assert.ok(cur.locked_at);
  // 경계: 종료일 다음 날 00:00 KST 직전까지 허용
  const edge = await mkChallenge(c.id, { start_date: today, end_date: today });
  const ea = await mkAssignment(edge.id, { items: ['x', 'y'] });
  const deadline = Date.parse(today + 'T00:00:00Z') - 9 * 3600e3 + DAY;
  setClockOffset(deadline - Date.now() - 1000);
  ok(await check(s, ea, ea.items[0]));
  setClockOffset(deadline - Date.now() + 1000);
  assert.equal((await check(s, ea, ea.items[1])).status, 409);
  assert.equal((await check(s, ea, ea.items[0], false)).status, 409);
});

test('AT-39/40/41 피드백: 본인만 조회, 읽음 버전, 완료율 무관, 공개 취소 제한', async () => {
  const c = await mkCourse('피드백', '1기');
  const e1 = await enroll(c.id, '피드1', '01011110001'); await enroll(c.id, '피드2', '01011110002');
  const ch = await mkChallenge(c.id); const a = await mkAssignment(ch.id);
  const s1 = await student('피드1', '01011110001'); const s2 = await student('피드2', '01011110002');
  ok(await s1.post(`/api/me/assignments/${a.id}/submissions`, { type: 'LINK', url: 'https://a.example.com' }));
  const fb = ok(await admin.post(`/api/enrollments/${e1.enrollment_id}/assignments/${a.id}/feedback`, { body: '좋아요' }));
  let v = ok(await s1.get(`/api/me/assignments/${a.id}`));
  assert.equal(v.feedback.length, 1); assert.equal(v.feedback[0].is_new, true); assert.equal(v.status, 'IN_PROGRESS');
  assert.equal(ok(await s2.get(`/api/me/assignments/${a.id}`)).feedback.length, 0);
  assert.equal((await s2.post(`/api/me/feedback/${fb.id}/read`)).status, 404);
  ok(await s1.post(`/api/me/feedback/${fb.id}/read`));
  assert.equal(ok(await s1.get(`/api/me/assignments/${a.id}`)).feedback[0].is_new, false);
  ok(await s1.patch(`/api/me/submissions/${v.submissions[0].id}`, { url: 'https://b.example.com' }));
  ok(await admin.patch(`/api/feedback/${fb.id}`, { body: '수정된 피드백', version: 1 }));
  v = ok(await s1.get(`/api/me/assignments/${a.id}`));
  assert.equal(v.feedback[0].is_new, true); assert.equal(v.feedback[0].refs[0].state, 'CHANGED');
  // 피드백만 있고 수행 없는 과제도 공개 취소 불가
  const b = await mkAssignment(ch.id);
  ok(await admin.post(`/api/enrollments/${e1.enrollment_id}/assignments/${b.id}/feedback`, { body: '미리 안내' }));
  assert.equal(ok(await admin.get(`/api/assignments/${b.id}`)).locked_at, null);
  assert.equal((await admin.post(`/api/assignments/${b.id}/unpublish`)).status, 409);
});

test('AT-42~48 등록 비활성화 범위, 권한 우회 차단, 빈 집계, 진행 행 없는 학생', async () => {
  const c1 = await mkCourse('권한1', '1기'); const c2 = await mkCourse('권한2', '1기');
  const e1 = await enroll(c1.id, '권한생', '01022220001'); await enroll(c2.id, '권한생', '01022220001');
  await enroll(c1.id, '타인', '01022220002');
  const ch = await mkChallenge(c1.id); const a = await mkAssignment(ch.id);
  const me = await student('권한생', '01022220001'); const other = await student('타인', '01022220002');
  const f = ok(await me.uploadFile('note.txt', Buffer.from('hello')));
  ok(await me.post(`/api/me/assignments/${a.id}/submissions`, { type: 'FILE', file_id: f.id }));
  assert.equal((await other.get(`/api/files/${f.id}/download`)).status, 404);
  assert.equal((await C().get(`/api/files/${f.id}/download`)).status, 401);
  assert.equal((await other.get(`/api/me/courses/${c2.id}`)).status, 404);
  ok(await admin.patch(`/api/courses/${c1.id}`, { state: 'ARCHIVED' }));
  ok(await me.get(`/api/me/courses/${c1.id}`));
  ok(await admin.patch(`/api/enrollments/${e1.enrollment_id}/status`, { status: 'INACTIVE', reason: '환불' }));
  assert.equal((await me.get(`/api/me/courses/${c1.id}`)).status, 404);
  assert.equal((await me.get(`/api/files/${f.id}/download`)).status, 404);
  ok(await me.get(`/api/me/courses/${c2.id}`));
  ok(await admin.patch(`/api/enrollments/${e1.enrollment_id}/status`, { status: 'ACTIVE', reason: '복원' }));
  const back = ok(await me.get(`/api/me/assignments/${a.id}`));
  assert.equal(back.submissions.length, 1);
  const prog = ok(await admin.get(`/api/courses/${c1.id}/progress`));
  assert.equal(prog.summary.target, 2); assert.equal(prog.summary.completed, 0);
  assert.equal(prog.rows.find((r) => r.student.name === '타인').cells[0].status, 'NOT_STARTED');
  const empty = ok(await admin.get(`/api/courses/${c2.id}`));
  assert.equal(empty.stats.rate, null); assert.equal(empty.stats.target, 0);
});

test('AT-47/49 집계: 건수 합산, 새 과제 공개 시 분모 갱신', async () => {
  const c = await mkCourse('집계', '1기');
  await enroll(c.id, '집1', '01033330001'); await enroll(c.id, '집2', '01033330002');
  const chA = await mkChallenge(c.id); const chB = await mkChallenge(c.id);
  const a1 = await mkAssignment(chA.id, { items: ['x'] });
  await mkAssignment(chB.id, { items: ['x'] }); await mkAssignment(chB.id, { items: ['x'] }); await mkAssignment(chB.id, { items: ['x'] });
  const s = await student('집1', '01033330001');
  ok(await check(s, a1, a1.items[0]));
  let st = ok(await admin.get(`/api/courses/${c.id}`)).stats;
  assert.equal(st.completed, 1); assert.equal(st.target, 8); assert.equal(st.rate, 12.5);
  await mkAssignment(chA.id, { items: ['x'] });
  st = ok(await admin.get(`/api/courses/${c.id}`)).stats;
  assert.equal(st.completed, 1); assert.equal(st.target, 10);
});

test('AT-50/52/53 권한 회수·세션 회수·멱등·충돌', async () => {
  const i = await mkInstructor('i5@t.com', '강사5');
  const c = await mkCourse('회수', '1기', [i.id]);
  await enroll(c.id, '멱등', '01044440001');
  const ch = await mkChallenge(c.id); const a = await mkAssignment(ch.id);
  const s = await student('멱등', '01044440001');
  ok(await check(s, a, a.items[0])); ok(await check(s, a, a.items[0])); ok(await check(s, a, a.items[0]));
  assert.equal((await get(`SELECT COUNT(*) AS n FROM progress_events pe JOIN task_progress tp ON tp.id = pe.task_progress_id WHERE tp.assignment_id = ? AND event_type = 'CHECKED'`, a.id)).n, 1);
  const key = 'sub-1';
  ok(await s.post(`/api/me/assignments/${a.id}/submissions`, { type: 'LINK', url: 'https://x.example.com', idempotency_key: key }));
  ok(await s.post(`/api/me/assignments/${a.id}/submissions`, { type: 'LINK', url: 'https://x.example.com', idempotency_key: key }));
  assert.equal((await get('SELECT COUNT(*) AS n FROM submissions WHERE assignment_id = ?', a.id)).n, 1);
  const chv = ok(await i.client.get(`/api/courses/${c.id}/challenges`)).items[0];
  ok(await admin.patch(`/api/challenges/${ch.id}`, { version: chv.version, title: '관리자 수정' }));
  const conflict = await i.client.patch(`/api/challenges/${ch.id}`, { version: chv.version, title: '강사 수정' });
  assert.equal(conflict.status, 409);
  ok(await admin.del(`/api/courses/${c.id}/instructors/${i.id}`));
  assert.equal((await i.client.get(`/api/courses/${c.id}`)).status, 404);
  ok(await i.client.get('/api/courses'));
  ok(await admin.patch(`/api/staff/${i.staffId}`, { status: 'DISABLED' }));
  assert.equal((await i.client.get('/api/courses')).status, 401);
  const lastAdmin = (await get(`SELECT id FROM staff_accounts WHERE email = 'admin@t.com'`)).id;
  assert.equal((await admin.patch(`/api/staff/${lastAdmin}`, { status: 'DISABLED' })).status, 409);
});

test('CSRF 토큰 없는 변경 요청 거부', async () => {
  const c = C(); ok(await c.staffLogin('admin@t.com', 'adminpass1'));
  c.csrf = '';
  assert.equal((await c.post('/api/courses', { title: 'x', cohort_label: 'y' })).status, 403);
});

test('XLSX 업로드: 숫자형 전화번호(앞자리 0 유실)는 오류 행, 텍스트 번호는 정상', async () => {
  const XLSX = require('xlsx');
  const c = await mkCourse('엑셀', '1기');
  const ws = XLSX.utils.aoa_to_sheet([['성명', '휴대폰'], ['엑셀1', '010-5555-0001'], ['엑셀2', 1055550002]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '명단');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const p = ok(await preview(admin, c.id, 'list.xlsx', buf));
  assert.equal(p.mapping.name, 0); assert.equal(p.mapping.phone, 1);
  assert.deepEqual(p.rows.map((r) => r.classification), ['NEW', 'ERROR']);
  assert.match(p.rows[1].error, /텍스트/);
  const xls = await preview(admin, c.id, 'old.xls', Buffer.from('x'));
  assert.equal(xls.status, 400); assert.match(xls.data.error.message, /xlsx/);
});

test('동시성: 첫 수행과 강사 수정 동시 요청, 동일 체크 동시 재전송, 동시 등록', async () => {
  const c = await mkCourse('동시성', '1기');
  await enroll(c.id, '동시1', '01066660001');
  const ch = await mkChallenge(c.id); const a = await mkAssignment(ch.id, { items: ['a', 'b'] });
  const s = await student('동시1', '01066660001');
  const cur = ok(await admin.get(`/api/assignments/${a.id}`));
  // 학생 첫 체크와 강사의 할 일 변경이 동시에 도착: 어느 쪽이 먼저든 동결 후 변경은 허용되지 않아야 한다
  const [chk, edit] = await Promise.all([
    check(s, a, a.items[0]),
    admin.patch(`/api/assignments/${a.id}`, { version: cur.version, items: [...cur.items, { title: 'c' }] }),
  ]);
  const after = ok(await admin.get(`/api/assignments/${a.id}`));
  if (chk.status === 200 && edit.status === 200) {
    // 강사 수정이 먼저 커밋된 경우: 학생 체크는 수정된 과제(할 일 3개)에 대해 이루어지고 이후 동결
    assert.equal(after.items.length, 3);
  } else {
    assert.equal(edit.status, 409); assert.equal(after.items.length, 2);
  }
  assert.ok(after.locked_at);
  // 같은 체크 요청 동시 재전송 → CHECKED 사건 1건
  await Promise.all([1, 2, 3, 4].map(() => check(s, a, a.items[1])));
  const n = (await get(`SELECT COUNT(*) AS n FROM progress_events pe JOIN task_progress tp ON tp.id = pe.task_progress_id
    WHERE tp.assignment_id = ? AND pe.event_type = 'CHECKED' AND pe.item_id_optional = ?`, a.id, a.items[1].id)).n;
  assert.equal(n, 1);
  // 같은 학생을 같은 강의에 동시 등록 → 1건만 생성
  const rs = await Promise.all([1, 2, 3].map(() => admin.post(`/api/courses/${c.id}/enrollments`, { name: '동시2', phone: '01066660002' })));
  assert.equal(rs.filter((x) => x.status === 201).length, 1);
  assert.ok(rs.every((x) => x.status === 201 || x.status === 409));
  assert.equal((await get(`SELECT COUNT(*) AS n FROM students WHERE normalized_phone = '01066660002'`)).n, 1);
});

test('정리 작업 엔드포인트는 CRON_SECRET 없이는 숨김, 검증 실패 업로드는 저장소에서 삭제', async () => {
  assert.equal((await C().get('/api/cron/cleanup')).status, 404);
  process.env.CRON_SECRET = 'test-secret';
  const r = await C().req('GET', '/api/cron/cleanup', undefined, { headers: { authorization: 'Bearer test-secret' } });
  assert.equal(r.status, 200);
  delete process.env.CRON_SECRET;
  const bad = await admin.uploadFile('fake.png', Buffer.from('not a png'));
  assert.equal(bad.status, 400);
  const f = await get(`SELECT * FROM file_assets WHERE original_name = 'fake.png' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(f.status, 'DELETED');
  assert.equal(fs.existsSync(path.join(TMP, 'objects', f.object_key)), false);
  // 미완료(PENDING) 파일은 제출에 사용할 수 없음
  const prep = ok(await admin.post('/api/files/prepare', { name: 'x.pdf', size: 10 }));
  assert.equal((await admin.get(`/api/files/${prep.id}/download`)).status, 404);
});

test('다운로드 단기 URL(mode=json)도 같은 권한 검사를 거친다', async () => {
  const c = await mkCourse('다운로드', '1기');
  await enroll(c.id, '다운1', '01077770001'); await enroll(c.id, '다운2', '01077770002');
  const ch = await mkChallenge(c.id); const a = await mkAssignment(ch.id);
  const s1 = await student('다운1', '01077770001'); const s2 = await student('다운2', '01077770002');
  const f = ok(await s1.uploadFile('보고서.pdf', Buffer.from('%PDF-1.4 x')));
  ok(await s1.post(`/api/me/assignments/${a.id}/submissions`, { type: 'FILE', file_id: f.id }));
  const info = ok(await s1.get(`/api/files/${f.id}/download?mode=json`));
  assert.equal(info.name, '보고서.pdf'); assert.ok(info.url);
  assert.equal((await s2.get(`/api/files/${f.id}/download?mode=json`)).status, 404);
});

test('다른 계정 세션이 남은 브라우저에서 설정 링크 사용 후 새 계정 로그인', async () => {
  // 관리자로 로그인된 브라우저(보안 토큰 없음 = 화면이 로그아웃 상태로 바뀐 직후)에서 진행
  const browser = C(); ok(await browser.staffLogin('admin@t.com', 'adminpass1'));
  const adminCookie = browser.cookie;
  const r = ok(await admin.post('/api/staff', { email: 'newbie@t.com', name: '새강사', roles: ['INSTRUCTOR'] }));
  browser.csrf = '';
  ok(await browser.post('/api/auth/staff/setup', { token: r.setup_path.split('/').pop(), password: 'password123' }), 'setup');
  // 설정 후 이 브라우저의 기존(관리자) 세션은 종료된다
  assert.equal(browser.cookie, '');
  const stale = new (require('../scripts/client').Client)(base); stale.cookie = adminCookie;
  assert.equal((await stale.get('/api/me')).data.user, null);
  // 로그인 요청은 남은 세션의 보안 토큰을 요구하지 않고, 기존 세션을 교체한다
  const b2 = C(); b2.cookie = adminCookie;
  ok(await b2.staffLogin('newbie@t.com', 'password123'), 'login');
  assert.equal((await b2.get('/api/me')).data.user.email, 'newbie@t.com');
  // 세션이 있는 상태의 일반 변경 요청은 여전히 보안 토큰이 필요하다
  b2.csrf = '';
  const denied = await b2.post('/api/auth/logout');
  assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'CSRF');
});

test('강사 명단 관리: 담당 강의 개별 등록·엑셀 업로드·수정·삭제, 담당 외 거부', async () => {
  const i = await mkInstructor('roster-i@t.com', '명단강사');
  const mine = await mkCourse('명단', '1기', [i.id]); const theirs = await mkCourse('명단', '2기');
  // 개별 등록 (강사 메모는 관리자 전용이라 저장하지 않음)
  const e1 = ok(await i.client.post(`/api/courses/${mine.id}/enrollments`, { name: '강사등록', phone: '010-5100-0001', memo: '강사메모' }), 'manual');
  assert.equal((await get('SELECT admin_memo FROM enrollments WHERE id = ?', e1.enrollment_id)).admin_memo, null);
  assert.equal((await i.client.post(`/api/courses/${theirs.id}/enrollments`, { name: '남의강의', phone: '01051000002' })).status, 404);
  assert.equal((await i.client.post(`/api/courses/${mine.id}/enrollments`, { student_id: e1.student.id })).status, 403);
  // 다른 강의 학생과 이름 충돌 시 기존 정보는 노출하지 않음
  await enroll(theirs.id, '비밀이름', '01051000009');
  const conflict = await i.client.post(`/api/courses/${mine.id}/enrollments`, { name: '다른이름', phone: '01051000009' });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error.existing, undefined); assert.doesNotMatch(conflict.data.error.message, /비밀이름/);
  // 엑셀(CSV) 업로드 → 미리보기 → 확정
  const job = ok(await preview(i.client, mine.id, 'roster.csv', Buffer.from('이름,전화번호,메모\n업로드1,010-5100-0011,x\n비밀아님,01051000009,\n')), 'preview');
  assert.equal(job.committable, 1);
  assert.doesNotMatch(JSON.stringify(job.rows), /비밀이름/);
  let done = ok(await i.client.post(`/api/imports/${job.id}/commit`, { idempotency_key: job.id }));
  while (done.state === 'COMMITTING') done = ok(await i.client.post(`/api/imports/${job.id}/commit`, {}));
  assert.equal(done.state, 'COMMITTED'); assert.equal(done.result_counts.created, 1);
  // 관리자가 만든 다른 강의 업로드 작업은 볼 수 없음
  const adminJob = ok(await preview(admin, theirs.id, 'b.csv', Buffer.from('이름,전화번호\n관리자업로드,01051000021\n')));
  assert.equal((await i.client.get(`/api/imports/${adminJob.id}`)).status, 404);
  assert.equal((await i.client.post(`/api/imports/${adminJob.id}/commit`, {})).status, 404);
  // 수정: 담당 강의에만 등록된 학생은 강사가 이름·번호를 고칠 수 있음 (사유 필수)
  assert.equal((await i.client.patch(`/api/enrollments/${e1.enrollment_id}/student`, { phone: '01051000003' })).status, 400);
  ok(await i.client.patch(`/api/enrollments/${e1.enrollment_id}/student`, { name: '강사수정', phone: '01051000003', reason: '오타' }), 'edit');
  await student('강사수정', '01051000003'); // 바뀐 번호로 로그인 가능
  // 다른 강사의 강의에도 등록된 학생은 수정 불가
  await enroll(theirs.id, '강사수정', '01051000003');
  assert.equal((await i.client.patch(`/api/enrollments/${e1.enrollment_id}/student`, { name: '또수정', reason: 'x' })).status, 403);
  // 삭제: 기록이 없으면 삭제 (다른 등록이 없는 학생은 함께 삭제)
  const e2 = ok(await i.client.post(`/api/courses/${mine.id}/enrollments`, { name: '삭제대상', phone: '01051000004' }));
  const del = ok(await i.client.del(`/api/enrollments/${e2.enrollment_id}`));
  assert.equal(del.student_deleted, true);
  assert.equal(await get('SELECT id FROM students WHERE id = ?', e2.student.id), undefined);
  // 다른 강의에도 등록된 학생은 이 강의 등록만 삭제
  const del1 = ok(await i.client.del(`/api/enrollments/${e1.enrollment_id}`));
  assert.equal(del1.student_deleted, false);
  // 수행 기록이 있으면 삭제 대신 비활성화
  const ch = await mkChallenge(mine.id); const a = await mkAssignment(ch.id);
  const e3 = ok(await i.client.post(`/api/courses/${mine.id}/enrollments`, { name: '수행함', phone: '01051000005' }));
  const sc = await student('수행함', '01051000005');
  const detail = ok(await sc.get(`/api/me/assignments/${a.id}`));
  ok(await check(sc, a, detail.items[0]));
  const blocked = await i.client.del(`/api/enrollments/${e3.enrollment_id}`);
  assert.equal(blocked.status, 409); assert.equal(blocked.data.error.reason, 'HAS_ACTIVITY');
  ok(await i.client.patch(`/api/enrollments/${e3.enrollment_id}/status`, { status: 'INACTIVE', reason: '중도탈퇴' }));
  ok(await i.client.patch(`/api/enrollments/${e3.enrollment_id}/status`, { status: 'ACTIVE', reason: '재활성화' }));
  // 담당 외 강의 등록은 수정·삭제·상태 변경 모두 404
  const foreign = await enroll(theirs.id, '남의학생', '01051000006');
  assert.equal((await i.client.del(`/api/enrollments/${foreign.enrollment_id}`)).status, 404);
  assert.equal((await i.client.patch(`/api/enrollments/${foreign.enrollment_id}/student`, { name: 'x', reason: 'x' })).status, 404);
  assert.equal((await i.client.patch(`/api/enrollments/${foreign.enrollment_id}/status`, { status: 'INACTIVE', reason: 'x' })).status, 404);
});

test('외부 API 명단 가져오기 (관리자 전용): 연동 소스·연결 테스트·미리보기·확정', async () => {
  const http = require('http');
  let lastReq;
  const api = http.createServer((req, res) => {
    lastReq = { url: req.url, auth: req.headers.authorization };
    if (req.headers.authorization !== 'Bearer secret-token') { res.writeHead(401); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { students: [
      { profile: { name: 'API학생1' }, mobile: '010-5200-0001', note: '결제완료' },
      { profile: { name: 'API학생2' }, mobile: 1052000002 }, // 숫자형 → 앞자리 0 유실 → 오류 행
      { profile: { name: '' }, mobile: '01052000003' },
    ] } }));
  }).listen(0);
  const apiBase = `http://127.0.0.1:${api.address().port}`;
  try {
    const i = await mkInstructor('api-i@t.com', 'API강사');
    const c = await mkCourse('API연동', '1기', [i.id]);
    const body = { name: '결제 시스템', url: `${apiBase}/students?course={course_code}&q={param}`, headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
      items_path: 'data.students', name_field: 'profile.name', phone_field: 'mobile', memo_field: 'note' };
    assert.equal((await i.client.post('/api/roster-sources', body)).status, 403);
    const src = ok(await admin.post('/api/roster-sources', body), 'create source');
    assert.deepEqual(src.header_names, ['Authorization']);
    assert.doesNotMatch(JSON.stringify(ok(await admin.get('/api/roster-sources'))), /secret-token/);
    // 값 없이 수정하면 기존 인증 헤더 유지
    ok(await admin.patch(`/api/roster-sources/${src.id}`, { name: '결제 시스템(수정)', headers: [{ name: 'Authorization' }] }));
    const t = ok(await admin.post(`/api/roster-sources/${src.id}/test`, { course_id: c.id, param: '봄 학기' }), 'test');
    assert.equal(t.total, 3); assert.equal(t.valid, 1); assert.ok(t.keys.includes('mobile'));
    assert.equal(lastReq.url, `/students?course=${c.code}&q=%EB%B4%84%20%ED%95%99%EA%B8%B0`);
    assert.equal((await i.client.post(`/api/courses/${c.id}/imports/api`, { source_id: src.id })).status, 403);
    const job = ok(await admin.post(`/api/courses/${c.id}/imports/api`, { source_id: src.id }), 'api import');
    assert.equal(job.source_type, 'API'); assert.equal(job.committable, 1);
    assert.deepEqual(job.rows.map((r) => r.classification), ['NEW', 'ERROR', 'ERROR']);
    assert.equal((await admin.post(`/api/imports/${job.id}/remap`, { mapping: {} })).status, 400);
    let done = ok(await admin.post(`/api/imports/${job.id}/commit`, { idempotency_key: job.id }));
    while (done.state === 'COMMITTING') done = ok(await admin.post(`/api/imports/${job.id}/commit`, {}));
    assert.equal(done.result_counts.created, 1);
    const e = await get(`SELECT e.admin_memo, ev.reason FROM enrollments e JOIN enrollment_events ev ON ev.enrollment_id = e.id
      JOIN students s ON s.id = e.student_id WHERE s.normalized_phone = '01052000001'`);
    assert.equal(e.admin_memo, '결제완료'); assert.equal(e.reason, 'API');
    // 같은 명단을 다시 가져오면 중복 등록 없음
    const again = ok(await admin.post(`/api/courses/${c.id}/imports/api`, { source_id: src.id }));
    assert.equal(again.committable, 0); assert.equal(again.rows[0].classification, 'ALREADY_ENROLLED');
    // 인증 실패는 사용자용 메시지로
    ok(await admin.patch(`/api/roster-sources/${src.id}`, { headers: [{ name: 'Authorization', value: 'Bearer wrong' }] }));
    const bad = await admin.post(`/api/courses/${c.id}/imports/api`, { source_id: src.id });
    assert.equal(bad.status, 400); assert.match(bad.data.error.message, /HTTP 401/);
    // 사설망 주소 차단 규칙
    const { isBlockedAddress } = require('../src/rosterApi');
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isBlockedAddress(ip), ip);
    for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.ok(!isBlockedAddress(ip), ip);
  } finally { api.close(); }
});

test('공개 과제 노출: 등록 순서와 무관, 초안 챌린지 안의 과제는 숨김, 챌린지 함께 공개', async () => {
  const c = await mkCourse('노출', '1기');
  // 챌린지(초안)와 과제를 먼저 만들고 과제만 공개한 뒤, 수강생을 나중에 등록 (실제 운영 상황 재현)
  const ch = await mkChallenge(c.id, { visibility: 'DRAFT' });
  const a = await mkAssignment(ch.id);
  await enroll(c.id, '나중등록', '01053000001');
  const s = await student('나중등록', '01053000001');
  const titles = async () => (ok(await s.get(`/api/me/courses/${c.id}`)).challenges || []).flatMap((x) => (x.assignments || []).map((y) => y.id));
  assert.deepEqual(await titles(), []);
  assert.equal((await s.get(`/api/me/assignments/${a.id}`)).status, 404);
  // 과제 공개 시 챌린지도 함께 공개 → 나중에 등록한 학생에게도 바로 보임
  ok(await admin.post(`/api/assignments/${a.id}/publish`, { publish_challenge: true }));
  assert.equal((await get('SELECT visibility FROM challenges WHERE id = ?', ch.id)).visibility, 'PUBLISHED');
  assert.deepEqual(await titles(), [a.id]);
  ok(await s.get(`/api/me/assignments/${a.id}`));
  // 공개 이후에 등록한 학생도 동일하게 보임
  await enroll(c.id, '더나중', '01053000002');
  const s2 = await student('더나중', '01053000002');
  ok(await s2.get(`/api/me/assignments/${a.id}`));
});
