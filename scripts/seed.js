'use strict';
// 데모 데이터 생성. 사용: npm run seed  (빈 DB에서 실행 권장)
const { get, run, uuid, now, close } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { createApp } = require('../src/server');
const { Client } = require('./client');

const ADMIN = { email: 'admin@bizup.local', password: 'admin1234!' };
const INSTRUCTOR = { email: 'teacher@bizup.local', password: 'teacher1234!', name: '김강사' };
const kstDate = (offsetDays) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

(async () => {
  if (await get('SELECT 1 AS ok FROM courses LIMIT 1')) { console.log('이미 데이터가 있어 시드를 건너뜁니다.'); await close(); return; }
  if (!(await get('SELECT 1 AS ok FROM staff_accounts WHERE email = ?', ADMIN.email))) {
    const id = uuid();
    await run(`INSERT INTO staff_accounts(id, email, name, password_hash, status, created_at, updated_at) VALUES(?,?,?,?,'ACTIVE',?,?)`,
      id, ADMIN.email, '운영관리자', await hashPassword(ADMIN.password), now(), now());
    await run(`INSERT INTO staff_roles(staff_id, role) VALUES(?, 'ADMIN')`, id);
  }
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const must = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
  try {
    const admin = new Client(base);
    must(await admin.staffLogin(ADMIN.email, ADMIN.password), 'admin login');
    const ins = must(await admin.post('/api/staff', { email: INSTRUCTOR.email, name: INSTRUCTOR.name, roles: ['INSTRUCTOR'] }), 'create instructor');
    const token = ins.setup_path.split('/').pop();
    must(await new Client(base).post('/api/auth/staff/setup', { token, password: INSTRUCTOR.password }), 'setup instructor');
    const c1 = must(await admin.post('/api/courses', { title: '블로그 수익화 클래스', cohort_label: '1기', description: '블로그로 첫 수익을 만드는 4주 실행 과정', starts_on: kstDate(-7), ends_on: kstDate(30), state: 'ACTIVE', instructor_ids: [ins.staff.instructor_id] }), 'course1');
    must(await admin.post('/api/courses', { title: '블로그 수익화 클래스', cohort_label: '2기', state: 'READY', instructor_ids: [ins.staff.instructor_id] }), 'course2');
    const students = [['김민수', '010-1111-2222'], ['이지은', '010-3333-4444'], ['박서준', '010-5555-6666'], ['최유리', '010-7777-8888']];
    for (const [name, phone] of students) must(await admin.post(`/api/courses/${c1.id}/enrollments`, { name, phone }), 'enroll');
    const ch = must(await admin.post(`/api/courses/${c1.id}/challenges`, { title: '블로그 첫 수익 실행 챌린지', description: '매주 과제를 수행하고 결과물을 제출하세요.', start_date: kstDate(-3), end_date: kstDate(25), visibility: 'PUBLISHED' }), 'challenge');
    const a1 = must(await admin.post(`/api/challenges/${ch.id}/assignments`, { title: '1주차: 블로그 개설', description: '블로그를 개설하고 기본 설정을 마칩니다.', items: [{ title: '블로그 개설하기' }, { title: '프로필 사진·소개 작성' }, { title: '카테고리 3개 만들기' }] }), 'a1');
    must(await admin.post(`/api/assignments/${a1.id}/resources`, { type: 'LINK', url: 'https://example.com/guide', title: '블로그 개설 가이드' }), 'res');
    must(await admin.post(`/api/assignments/${a1.id}/publish`), 'pub1');
    const a2 = must(await admin.post(`/api/challenges/${ch.id}/assignments`, { title: '2주차: 첫 글 발행', description: '주제를 정하고 첫 글을 발행한 뒤 링크를 제출하세요.', submission_required: true, items: [{ title: '키워드 3개 조사' }, { title: '1,500자 이상 글 작성' }, { title: '글 발행하기' }] }), 'a2');
    must(await admin.post(`/api/assignments/${a2.id}/publish`), 'pub2');
    const stu = new Client(base);
    must(await stu.studentLogin('김민수', '01011112222'), 'student login');
    for (const it of a1.items) must(await stu.put(`/api/me/assignments/${a1.id}/items/${it.id}`, { is_checked: true }), 'check');
    must(await stu.put(`/api/me/assignments/${a2.id}/items/${a2.items[0].id}`, { is_checked: true }), 'check2');
    console.log('\n데모 데이터가 생성되었습니다.');
    console.log(`  관리자  : ${ADMIN.email} / ${ADMIN.password}`);
    console.log(`  강사    : ${INSTRUCTOR.email} / ${INSTRUCTOR.password}`);
    console.log('  수강생  : 이름 김민수 / 전화번호 01011112222 (그 외 이지은 01033334444 등)');
  } finally { server.close(); await close(); }
})().catch((e) => { console.error(e); process.exit(1); });
