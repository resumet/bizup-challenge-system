'use strict';
/* ===== 공통 유틸 ===== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const APP = () => $('#app');
let ME = null; let CSRF = '';

/* 아이콘: 이모지 대신 currentColor를 따르는 인라인 SVG (stroke 1.75 통일) */
const ICON_PATHS = {
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  upload: '<path d="M12 15V4"/><path d="m7 9 5-5 5 5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  box: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/>',
  checkbox: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
};
const icon = (name, label) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${ICON_PATHS[name]}</svg>`;

const STATUS = {
  NOT_STARTED: { label: '미시작' },
  IN_PROGRESS: { label: '진행 중' },
  NEED_SUBMISSION: { label: '제출 필요' },
  COMPLETED: { label: '완료' },
  COMPLETED_LATE: { label: '기한 후 완료' },
};
// long === false: 점만 표시 (매트릭스 셀). 라벨은 스크린리더·툴팁으로 유지
const statusBadge = (s, long) => `<span class="badge st-${s}${long === false ? ' dot-only' : ''}" title="${esc(STATUS[s].label)}"><i class="dot" aria-hidden="true"></i>${long === false ? `<span class="sr">${esc(STATUS[s].label)}</span>` : esc(STATUS[s].label)}</span>`;
const skeleton = (rows = 4) => `<div class="skeleton" aria-busy="true" aria-label="불러오는 중"><span class="sk sk-title"></span><span class="sk sk-line"></span>${'<span class="sk sk-block"></span>'.repeat(rows)}</div>`;
const COURSE_STATE = { READY: '준비 중', ACTIVE: '진행 중', ENDED: '종료', ARCHIVED: '보관' };
const courseStateBadge = (s) => `<span class="badge ${s === 'ACTIVE' ? 'ok' : s === 'READY' ? 'primary' : ''}">${COURSE_STATE[s]}</span>`;
const PHASE = { UPCOMING: ['시작 전', 'primary'], RUNNING: ['진행 중', 'ok'], ENDED: ['종료', ''] };
const phaseBadge = (p) => `<span class="badge ${PHASE[p][1]}">${PHASE[p][0]}</span>`;

const dtFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function fmtDT(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(dtFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1048576).toFixed(1)}MB`);
const pctText = (rate) => (rate == null ? '—' : `${rate.toFixed(1)}%`);
const progressBar = (rate) => `<div class="progress" aria-hidden="true"><span style="width:${rate || 0}%"></span></div>`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 't' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 5000 : 2500);
}

class ApiError extends Error {
  constructor(status, body) { super((body && body.error && body.error.message) || '요청을 처리하지 못했습니다.'); this.status = status; this.body = body && body.error; this.code = this.body && this.body.code; }
}
async function api(method, path, body, opts = {}) {
  const headers = {};
  if (CSRF && method !== 'GET') headers['x-csrf-token'] = CSRF;
  let payload;
  if (opts.form) payload = opts.form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' }); } catch (e) {
    throw new ApiError(0, { error: { message: '네트워크 연결을 확인해주세요. 저장 여부를 확인하기 위해 화면을 새로고침합니다.' } });
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const wasStaff = ME && ME.type === 'STAFF';
    ME = null; CSRF = '';
    location.hash = wasStaff ? '#/staff-login' : '#/login';
    throw new ApiError(401, data);
  }
  // 다른 탭에서 로그인·로그아웃해 보안 토큰이 바뀐 경우: 최신 토큰을 받아 한 번만 다시 시도한다.
  if (res.status === 403 && data && data.error && data.error.code === 'CSRF' && !opts.retried) {
    const before = ME && ME.id;
    await loadMe();
    // 그사이 다른 계정으로 바뀌었다면 그 계정으로 실행하지 않는다
    if (ME && ME.id === before) return api(method, path, body, { ...opts, retried: true });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b = {}) => api('POST', p, b);
const PUT = (p, b = {}) => api('PUT', p, b);
const PATCH = (p, b = {}) => api('PATCH', p, b);
const DEL = (p) => api('DELETE', p);
// 업로드: 서버에 전송 준비 요청 → 저장소로 직접 전송 → 서버가 내용 검증 후 확정
async function uploadFile(file, purpose) {
  const prep = await POST('/api/files/prepare', { name: file.name, size: file.size, purpose });
  if (file.size > prep.max_bytes) throw new ApiError(400, { error: { message: `파일 크기는 최대 ${Math.round(prep.max_bytes / 1048576)}MB입니다.` } });
  let res;
  try {
    if (prep.upload.type === 'local') {
      res = await fetch(prep.upload.url, { method: 'PUT', headers: { 'x-csrf-token': CSRF, 'content-type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
    } else {
      // Supabase Storage 서명 업로드 URL (일회성 토큰 포함)
      const fd = new FormData();
      fd.append('cacheControl', '3600');
      fd.append('', file);
      res = await fetch(prep.upload.url, { method: 'PUT', headers: { 'x-upsert': 'false' }, body: fd });
    }
  } catch (_) { res = null; }
  if (!res || !res.ok) throw new ApiError(0, { error: { message: '파일이 등록되지 않았습니다. 다시 시도해주세요.' } });
  return POST(`/api/files/${prep.id}/complete`);
}
function qs(obj) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
}
function errMsg(e) { return e && e.message ? e.message : '오류가 발생했습니다.'; }

/* 모달 */
function modal(html, { wide } = {}) {
  const root = $('#modal-root');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(bg);
  const prev = document.activeElement;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
  const first = $('input, select, textarea, button', bg);
  if (first) first.focus();
  return { el: bg, close };
}
function confirmModal(message, { okText = '확인', danger } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<p class="pre">${esc(message)}</p><div class="actions"><button class="btn" data-close>취소</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cm-ok">${esc(okText)}</button></div>`);
    $('#cm-ok', m.el).addEventListener('click', () => { m.close(); resolve(true); });
    $$('[data-close]', m.el).forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}
function formData(form) {
  const o = {};
  new FormData(form).forEach((v, k) => { o[k] = typeof v === 'string' ? v : v; });
  return o;
}
// 폼 제출 공통: 저장 중 표시, 실패 시 메시지 유지
function bindForm(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const err = $('.form-error', form);
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '저장 중…'; }
    try { await handler(formData(form), form); } catch (ex) {
      if (err) err.textContent = errMsg(ex); else toast(errMsg(ex), true);
    } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; } }
  });
}
function pagination(total, page, size, onGo) {
  const pages = Math.max(1, Math.ceil(total / size));
  const div = document.createElement('div');
  div.className = 'pagination';
  div.innerHTML = `<span class="muted">총 ${total}건</span>
    <select aria-label="페이지 크기">${[20, 50, 100].map((n) => `<option value="${n}" ${n === size ? 'selected' : ''}>${n}명씩</option>`).join('')}</select>
    <button class="btn sm" ${page <= 1 ? 'disabled' : ''} data-p="${page - 1}">이전</button><span>${page} / ${pages}</span>
    <button class="btn sm" ${page >= pages ? 'disabled' : ''} data-p="${page + 1}">다음</button>`;
  $$('button[data-p]', div).forEach((b) => b.addEventListener('click', () => onGo(Number(b.dataset.p), size)));
  $('select', div).addEventListener('change', (e) => onGo(1, Number(e.target.value)));
  return div;
}

/* 파일 다운로드: 권한 확인된 단기 URL을 받아 원래 파일명으로 저장 (모든 /api/files/:id/download 링크에 적용) */
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[href^="/api/files/"][href$="/download"]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  try {
    const info = await GET(a.getAttribute('href') + '?mode=json');
    const res = await fetch(info.url, { credentials: info.url.startsWith('/') ? 'same-origin' : 'omit' });
    if (!res.ok) throw new Error();
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url; link.download = info.name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    toast(err instanceof ApiError ? errMsg(err) : '파일을 내려받지 못했습니다. 다시 시도해주세요.', true);
  }
});

/* ===== 라우터 ===== */
const routes = [];
function route(pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, handler, opts });
}
async function loadMe() {
  const r = await GET('/api/me');
  ME = r.user; CSRF = r.csrf_token || '';
}
function renderTopbar() {
  const tb = $('#topbar');
  const brand = `<a class="brand" href="#/"><span class="mark" aria-hidden="true">B</span>비즈업클래스 <span class="brand-sub">챌린지</span></a>`;
  if (!ME) { tb.innerHTML = `<div class="inner">${brand}</div>`; return; }
  const h = location.hash;
  const link = (href, label, match) => `<a href="${href}" class="${(match || ((x) => x.startsWith(href)))(h) ? 'on' : ''}">${label}</a>`;
  let nav = '';
  if (ME.type === 'STUDENT') {
    nav = link('#/s', '내 강의', (x) => x === '#/s' || x.startsWith('#/s/c') || x.startsWith('#/s/a')) + link('#/s/me', '내 정보');
  } else {
    if (ME.isAdmin) nav += link('#/a/dashboard', '대시보드');
    nav += link('#/a/courses', ME.isAdmin ? '강의' : '내 강의', (x) => x.startsWith('#/a/courses') || x.startsWith('#/a/c/') || x.startsWith('#/a/as/') || x.startsWith('#/a/e/') || x.startsWith('#/a/import'));
    if (ME.isAdmin) nav += link('#/a/staff', '강사 관리') + link('#/a/students', '전체 수강생', (x) => x.startsWith('#/a/students') || x.startsWith('#/a/st/')) + link('#/a/sources', '외부 연동') + link('#/a/logs', '변경 이력');
    nav += link('#/a/account', '내 계정');
  }
  tb.innerHTML = `<div class="inner">${brand}<nav>${nav}</nav>
    <span class="who hide-sm"><span class="avatar" aria-hidden="true">${esc((ME.name || '?').slice(0, 1))}</span>${esc(ME.name)}${ME.type === 'STAFF' ? ` <span class="muted">${ME.roles.map((r) => (r === 'ADMIN' ? '관리자' : '강사')).join('·')}</span>` : ''}</span>
    <button class="btn sm ghost" id="logout">로그아웃</button></div>`;
  $('#logout').addEventListener('click', logout);
}
async function logout() {
  const wasStaff = ME && ME.type === 'STAFF';
  try { await POST('/api/auth/logout'); } catch (_) { /* ignore */ }
  ME = null; CSRF = '';
  location.hash = wasStaff ? '#/staff-login' : '#/login';
}
async function router() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (h === '/' || h === '') {
    if (!ME) return (location.hash = '#/login');
    return (location.hash = ME.type === 'STUDENT' ? '#/s' : ME.isAdmin ? '#/a/dashboard' : '#/a/courses');
  }
  for (const r of routes) {
    const m = h.split('?')[0].match(r.re);
    if (!m) continue;
    const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const query = Object.fromEntries(new URLSearchParams(h.split('?')[1] || ''));
    if (r.opts.auth === 'STUDENT' && (!ME || ME.type !== 'STUDENT')) return (location.hash = '#/login');
    if (r.opts.auth === 'STAFF' && (!ME || ME.type !== 'STAFF')) return (location.hash = '#/staff-login');
    if (r.opts.auth === 'ADMIN' && (!ME || !ME.isAdmin)) return (location.hash = ME ? '#/' : '#/staff-login');
    renderTopbar();
    APP().className = r.opts.narrow ? 'narrow' : '';
    APP().innerHTML = skeleton(r.opts.narrow ? 3 : 4);
    try { await r.handler(params, query); } catch (e) {
      if (e.status === 401) return;
      APP().innerHTML = `<div class="card center pad"><p>${esc(errMsg(e))}</p><a class="btn" href="#/">처음으로</a></div>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  APP().innerHTML = '<div class="card center pad">페이지를 찾을 수 없습니다. <a href="#/">처음으로</a></div>';
}
function rerender() { router(); }

/* ===== 로그인 ===== */
route('/login', async () => {
  if (ME) return (location.hash = '#/');
  renderTopbar();
  APP().className = 'narrow';
  APP().innerHTML = `<div class="login-wrap"><div class="card">
    <h1>수강생 로그인</h1><p class="muted small">등록된 이름과 전화번호로 로그인합니다.</p>
    <form id="f" class="mt" autocomplete="on">
      <div class="field"><label for="name">아이디 (이름)</label><input type="text" id="name" name="name" autocomplete="name" required maxlength="50"></div>
      <div class="field"><label for="phone">비밀번호 (전화번호)</label><input type="tel" id="phone" name="phone" inputmode="numeric" autocomplete="tel" required maxlength="20" placeholder="01012345678">
      <div class="hint">전화번호는 숫자만 입력해주세요. (예: 01012345678)</div></div>
      <p class="form-error notice danger" style="display:none"></p>
      <button class="btn primary block" type="submit">로그인</button>
    </form></div>
    <p class="center small mt"><a href="#/staff-login">강사·관리자 로그인</a></p></div>`;
  const f = $('#f');
  const enter = async () => { await loadMe(); location.hash = '#/s'; };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', f); err.style.display = 'none';
    const btn = $('button', f); btn.disabled = true;
    const cred = { name: f.name.value, phone: f.phone.value };
    try {
      const r = await POST('/api/auth/student/login', cred);
      if (r.choose) chooseCourse(cred, r.choose); else await enter();
    } catch (ex) { err.textContent = errMsg(ex); err.style.display = 'block'; } finally { btn.disabled = false; }
  });
  // 같은 이름·전화번호로 여러 강의에 등록된 경우: 강의를 골라 그 강의로만 입장한다
  function chooseCourse(cred, list) {
    $('.login-wrap .card').innerHTML = `<h1>강의 선택</h1><p class="muted small">${esc(cred.name)}님으로 등록된 강의가 ${list.length}개 있습니다. 입장할 강의를 선택해주세요.</p>
      <ul class="list mt">${list.map((x) => `<li><button class="btn block" data-sid="${esc(x.student_id)}">${esc(x.title)} ${esc(x.cohort_label)}</button></li>`).join('')}</ul>
      <p class="form-error notice danger" style="display:none"></p>
      <p class="small muted mt">다른 강의로 바꾸려면 로그아웃한 뒤 다시 로그인해 선택하면 됩니다.</p>`;
    $$('[data-sid]').forEach((b) => b.addEventListener('click', async () => {
      $$('[data-sid]').forEach((x) => { x.disabled = true; });
      try { await POST('/api/auth/student/login', { ...cred, student_id: b.dataset.sid }); await enter(); } catch (ex) {
        const err = $('.login-wrap .form-error'); err.textContent = errMsg(ex); err.style.display = 'block';
        $$('[data-sid]').forEach((x) => { x.disabled = false; });
      }
    }));
  }
});
route('/staff-login', async () => {
  if (ME) return (location.hash = '#/');
  renderTopbar();
  APP().className = 'narrow';
  APP().innerHTML = `<div class="login-wrap"><div class="card">
    <h1>강사·관리자 로그인</h1>
    <form id="f" class="mt">
      <div class="field"><label for="email">이메일</label><input type="email" id="email" name="email" autocomplete="username" required></div>
      <div class="field"><label for="password">비밀번호</label><input type="password" id="password" name="password" autocomplete="current-password" required></div>
      <p class="form-error notice danger" style="display:none"></p>
      <button class="btn primary block" type="submit">로그인</button>
    </form>
    <p class="small muted mt">비밀번호를 잊었다면 관리자에게 재설정 링크를 요청해주세요.</p></div>
    <p class="center small mt"><a href="#/login">수강생 로그인</a></p></div>`;
  const f = $('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', f); err.style.display = 'none';
    const btn = $('button', f); btn.disabled = true;
    try {
      await POST('/api/auth/staff/login', { email: f.email.value, password: f.password.value });
      await loadMe(); location.hash = '#/';
    } catch (ex) { err.textContent = errMsg(ex); err.style.display = 'block'; } finally { btn.disabled = false; }
  });
});
route('/setup/:token', async ({ token }) => {
  renderTopbar();
  APP().className = 'narrow';
  let info;
  try { info = await GET('/api/auth/staff/setup/' + encodeURIComponent(token)); } catch (e) {
    APP().innerHTML = `<div class="login-wrap card"><h1>계정 설정</h1><p class="notice danger">${esc(errMsg(e))}</p></div>`; return;
  }
  APP().innerHTML = `<div class="login-wrap"><div class="card">
    <h1>${info.purpose === 'RESET' ? '비밀번호 재설정' : '계정 비밀번호 설정'}</h1>
    <p class="muted small">${esc(info.name)} (${esc(info.email)})<br>링크 만료: ${fmtDT(info.expires_at)}</p>
    <form id="f" class="mt">
      <div class="field"><label for="pw">새 비밀번호</label><input type="password" id="pw" name="pw" autocomplete="new-password" minlength="8" required><div class="hint">8자 이상</div></div>
      <div class="field"><label for="pw2">새 비밀번호 확인</label><input type="password" id="pw2" name="pw2" autocomplete="new-password" required></div>
      <p class="form-error small" style="color:var(--danger)"></p>
      <button class="btn primary block" type="submit">설정 완료</button>
    </form></div></div>`;
  bindForm($('#f'), async (d) => {
    if (d.pw !== d.pw2) throw new Error('비밀번호 확인이 일치하지 않습니다.');
    await POST('/api/auth/staff/setup', { token, password: d.pw });
    ME = null; CSRF = '';
    toast('비밀번호가 설정되었습니다. 새 비밀번호로 로그인해주세요.');
    location.hash = '#/staff-login';
  });
});

/* ===== 수강생 화면 ===== */
route('/s', async () => {
  const { items } = await GET('/api/me/courses');
  APP().innerHTML = `<h1>내 강의</h1><p class="muted small mb">${esc(ME.name)}님, 오늘도 한 걸음 실행해보세요.</p>
    ${items.length ? items.map((c) => `
      <a class="card link" href="#/s/c/${c.id}">
        <div class="row between"><div><strong>${esc(c.title)}</strong> <span class="badge">${esc(c.cohort_label)}</span></div>
        ${c.unread_feedback ? `<span class="badge new">새 피드백 ${c.unread_feedback}</span>` : ''}</div>
        <div class="small muted">강사: ${c.instructors.map((i) => esc(i.name)).join(', ') || '-'}${c.state === 'ENDED' || c.state === 'ARCHIVED' ? ' · 종료된 강의' : ''}</div>
        <div class="row mt"><div class="grow">${progressBar(c.rate)}</div><span class="small">${c.total ? `완료 ${c.completed}/${c.total} (${pctText(c.rate)})` : '공개된 과제가 없습니다'}</span></div>
        ${c.running_challenges.length ? `<div class="small mt">진행 중 챌린지: ${c.running_challenges.map((x) => `${esc(x.title)} (~${esc(x.end_date)})`).join(', ')}</div>` : ''}
      </a>`).join('') : '<div class="card center pad">현재 이용 가능한 강의가 없습니다. 운영자에게 문의해주세요.</div>'}
    <p class="small muted mt">다른 강의도 수강 중이라면 로그아웃한 뒤 다시 로그인해 강의를 선택해주세요.</p>`;
}, { auth: 'STUDENT', narrow: true });

route('/s/c/:id', async ({ id }) => {
  const c = await GET('/api/me/courses/' + id);
  APP().innerHTML = `<div class="breadcrumb"><a href="#/s">내 강의</a> ›</div>
    <h1>${esc(c.title)} <span class="badge">${esc(c.cohort_label)}</span></h1>
    <p class="small muted">강사: ${c.instructors.map((i) => esc(i.name)).join(', ') || '-'}</p>
    ${c.description ? `<p class="pre small">${esc(c.description)}</p>` : ''}
    <div class="card"><div class="row between"><strong>강의 진행률</strong><span>${c.total ? `완료 과제 ${c.completed}/${c.total} · ${pctText(c.rate)}` : '과제 없음'}</span></div><div class="mt">${progressBar(c.rate)}</div></div>
    <h2 class="mt">챌린지</h2>
    ${c.challenges.length ? c.challenges.map((ch) => `
      <div class="card">
        <div class="row between"><h3 style="margin:0">${esc(ch.title)}</h3>${phaseBadge(ch.phase)}</div>
        <div class="small muted">기간 ${esc(ch.start_date)} ~ ${esc(ch.end_date)} · ${ch.allow_after_deadline ? '종료 후에도 수행 가능' : '종료 후 마감'} · 완료 ${ch.completed}/${ch.total}</div>
        ${ch.notice ? `<p class="notice ${ch.can_act ? '' : 'warn'} mt small">${esc(ch.notice)}</p>` : ''}
        ${ch.description ? `<p class="pre small">${esc(ch.description)}</p>` : ''}
        <ul class="list mt">${ch.assignments.length ? ch.assignments.map((a) => `
          <li><a class="grow" href="#/s/a/${a.id}"><strong>${esc(a.title)}</strong></a>
            <span class="small muted">할 일 ${a.checked}/${a.item_count}${a.submission_required ? ' · 제출 필수' : ''}</span>
            ${a.unread_feedback ? `<span class="badge new">새 피드백 ${a.unread_feedback}</span>` : ''}
            ${statusBadge(a.status)}</li>`).join('') : '<li class="muted">공개된 과제가 없습니다.</li>'}</ul>
      </div>`).join('') : '<div class="card center muted">공개된 챌린지가 없습니다.</div>'}`;
}, { auth: 'STUDENT', narrow: true });

function renderStudentAssignment(a) {
  const locked = !a.can_act;
  const hasFiles = a.submissions.filter((s) => s.type === 'FILE').length;
  const hasLinks = a.submissions.filter((s) => s.type === 'LINK').length;
  APP().innerHTML = `<div class="breadcrumb"><a href="#/s">내 강의</a> › <a href="#/s/c/${a.course.id}">${esc(a.course.title)} ${esc(a.course.cohort_label)}</a> › ${esc(a.challenge.title)}</div>
    <h1>${esc(a.title)}</h1>
    <p class="small muted">챌린지 기간 ${esc(a.challenge.start_date)} ~ ${esc(a.challenge.end_date)} · ${a.challenge.allow_after_deadline ? '종료 후에도 수행 가능' : '종료 후 마감'}</p>
    ${a.notice ? `<p class="notice ${a.can_act ? '' : 'warn'}">${esc(a.notice)}</p>` : ''}
    <div class="card mt" id="status-card">
      <div class="row between"><strong>현재 상태</strong>${statusBadge(a.status)}</div>
      <p class="small mt" style="margin-bottom:0">할 일 ${a.checked}/${a.item_count} 완료 · 결과물 ${a.submission_required ? (a.submissions.length ? `제출됨(${a.submissions.length})` : '<strong>제출 필요</strong>') : `선택 제출${a.submissions.length ? ` (${a.submissions.length})` : ''}`}
      ${a.completed_at ? `<br>완료: ${fmtDT(a.completed_at)}${a.completion_timing === 'LATE' ? ' · <span class="badge late">기한 후 완료</span>' : ''}` : ''}</p>
      ${a.hint ? `<p class="notice warn small mt">${esc(a.hint)}</p>` : ''}
      <span class="saving" id="saving"></span>
    </div>
    ${a.description ? `<div class="card"><h3>과제 안내</h3><div class="pre">${esc(a.description)}</div></div>` : ''}
    ${a.resources.length ? `<div class="card"><h3>강사 자료</h3><ul class="list">${a.resources.map((r) => `<li>${r.type === 'LINK'
    ? `${icon('link')} <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>`
    : `${icon('file')} <a href="/api/files/${r.file_id}/download">${esc(r.title)}</a> <span class="small muted">${fmtSize(r.size)}</span>`}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><h3>해야 할 일 <span class="small muted">(${a.checked}/${a.item_count} 완료)</span></h3>
      <ul class="checklist">${a.items.map((it) => `<li class="${it.is_checked ? 'done' : ''}">
        <input type="checkbox" id="it-${it.id}" data-item="${it.id}" ${it.is_checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <label for="it-${it.id}">${esc(it.title)}${it.description ? `<div class="hint">${esc(it.description)}</div>` : ''}</label></li>`).join('')}</ul>
    </div>
    <div class="card"><h3>결과물 제출 ${a.submission_required ? '<span class="badge warn">필수</span>' : '<span class="badge">선택</span>'}</h3>
      <p class="small muted">${a.submission_required ? '파일 또는 링크 중 1개 이상 제출하면 조건이 충족됩니다.' : '결과물 제출은 선택입니다.'} 파일 최대 ${a.limits.files}개(개당 ${a.limits.max_mb}MB), 링크 최대 ${a.limits.links}개</p>
      <ul class="list">${a.submissions.map((s) => `<li>
        ${s.type === 'LINK' ? `${icon('link')} <a class="grow" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" style="word-break:break-all">${esc(s.url)}</a>`
    : `${icon('file')} <a class="grow" href="/api/files/${s.file_id}/download">${esc(s.original_name)}</a> <span class="small muted">${fmtSize(s.size)}</span>`}
        <span class="small muted">${fmtDT(s.revised_at)}${s.current_revision > 1 ? ` · 수정 ${s.current_revision - 1}회` : ''}</span>
        ${locked ? '' : `<button class="btn sm" data-edit-sub="${s.id}" data-type="${s.type}">${s.type === 'LINK' ? '수정' : '교체'}</button><button class="btn sm danger" data-del-sub="${s.id}">삭제</button>`}
      </li>`).join('') || '<li class="muted small">제출한 결과물이 없습니다.</li>'}</ul>
      ${locked ? '<p class="small muted mt">제출 기간이 종료되었습니다.</p>' : `
      <form id="link-form" class="row mt"><input class="grow" type="url" name="url" placeholder="https://" aria-label="제출 링크" ${hasLinks >= a.limits.links ? 'disabled' : ''} required><button class="btn" type="submit" ${hasLinks >= a.limits.links ? 'disabled' : ''}>링크 제출</button></form>
      <div class="row mt"><label class="btn" for="file-input" style="margin:0" ${hasFiles >= a.limits.files ? 'aria-disabled="true"' : ''}>${icon('upload')} 사진·파일 제출</label>
        <input type="file" id="file-input" accept="${a.limits.extensions.join(',')},image/*" style="position:absolute;left:-9999px" ${hasFiles >= a.limits.files ? 'disabled' : ''}>
        <span class="small muted" id="upload-state"></span></div>`}
    </div>
    <div class="card"><h3>강사 피드백</h3>
      ${a.feedback.length ? a.feedback.map((f) => `<div class="feedback">
        <div class="row between small"><strong>${esc(f.author_name)}</strong><span class="muted">${fmtDT(f.created_at)}${f.edited ? ` · 수정됨 ${fmtDT(f.updated_at)}` : ''} ${f.is_new ? '<span class="badge new">새 피드백</span>' : ''}</span></div>
        <div class="pre mt">${esc(f.body)}</div>
        ${f.refs.length ? `<div class="small muted mt">피드백 당시 제출물: ${f.refs.map((r) => `${esc(r.label)} (버전 ${r.revision}${r.state === 'CHANGED' ? ', 이후 수정됨' : r.state === 'REMOVED' ? ', 삭제됨' : ''})`).join(', ')}</div>` : ''}
      </div>`).join('') : '<p class="muted small">아직 피드백이 없습니다.</p>'}
    </div>`;
  bindStudentAssignment(a);
  // 화면에 표시된 새 피드백 읽음 처리 (완료율과 무관)
  a.feedback.filter((f) => f.is_new).forEach((f) => POST(`/api/me/feedback/${f.id}/read`).catch(() => {}));
}
function bindStudentAssignment(a) {
  const saving = $('#saving');
  const run = async (fn, okMsg) => {
    saving.textContent = '저장 중…';
    try { const next = await fn(); renderStudentAssignment(next); toast(okMsg || '저장되었습니다.'); } catch (e) {
      toast(errMsg(e), true);
      try { renderStudentAssignment(await GET('/api/me/assignments/' + a.id)); } catch (_) { /* ignore */ } // 서버 상태로 재동기화
    }
  };
  $$('[data-item]').forEach((cb) => cb.addEventListener('change', () => {
    $$('[data-item]').forEach((x) => { x.disabled = true; });
    run(() => PUT(`/api/me/assignments/${a.id}/items/${cb.dataset.item}`, { is_checked: cb.checked }), cb.checked ? '체크했습니다.' : '체크를 해제했습니다.');
  }));
  const lf = $('#link-form');
  if (lf) lf.addEventListener('submit', (e) => { e.preventDefault(); run(() => POST(`/api/me/assignments/${a.id}/submissions`, { type: 'LINK', url: lf.url.value.trim(), idempotency_key: uid() }), '링크를 제출했습니다.'); });
  const fi = $('#file-input');
  if (fi) fi.addEventListener('change', async () => {
    const file = fi.files[0]; if (!file) return;
    const st = $('#upload-state'); st.textContent = `업로드 중… (${file.name})`;
    try {
      const f = await uploadFile(file);
      st.textContent = '제출 확정 중…';
      await run(() => POST(`/api/me/assignments/${a.id}/submissions`, { type: 'FILE', file_id: f.id, idempotency_key: uid() }), '파일을 제출했습니다.');
    } catch (e) { st.textContent = ''; toast(errMsg(e) || '파일이 등록되지 않았습니다. 다시 시도해주세요.', true); }
  });
  $$('[data-del-sub]').forEach((b) => b.addEventListener('click', async () => {
    const last = a.submission_required && a.submissions.length === 1 && a.status.startsWith('COMPLETED');
    if (!(await confirmModal(last ? '마지막 제출물을 삭제하면 이 과제의 완료가 취소됩니다. 삭제할까요?' : '이 제출물을 삭제할까요?', { okText: '삭제', danger: true }))) return;
    run(() => DEL('/api/me/submissions/' + b.dataset.delSub), '삭제했습니다.');
  }));
  $$('[data-edit-sub]').forEach((b) => b.addEventListener('click', () => {
    const sid = b.dataset.editSub;
    if (b.dataset.type === 'LINK') {
      const cur = a.submissions.find((s) => s.id === sid);
      const m = modal(`<h2>링크 수정</h2><form id="ef"><div class="field"><input type="url" name="url" value="${esc(cur.url)}" required></div>
        <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
      $('#ef', m.el).addEventListener('submit', (e) => { e.preventDefault(); const url = e.target.url.value.trim(); m.close(); run(() => PATCH('/api/me/submissions/' + sid, { url }), '링크를 수정했습니다.'); });
    } else {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = a.limits.extensions.join(',') + ',image/*';
      input.addEventListener('change', async () => {
        const file = input.files[0]; if (!file) return;
        saving.textContent = '업로드 중…';
        try { const f = await uploadFile(file); await run(() => PATCH('/api/me/submissions/' + sid, { file_id: f.id }), '파일을 교체했습니다.'); } catch (e) { saving.textContent = ''; toast(errMsg(e), true); }
      });
      input.click();
    }
  }));
}
route('/s/a/:id', async ({ id }) => { renderStudentAssignment(await GET('/api/me/assignments/' + id)); }, { auth: 'STUDENT', narrow: true });

route('/s/me', async () => {
  const p = await GET('/api/me/profile');
  APP().innerHTML = `<h1>내 정보</h1><div class="card"><dl class="kv">
    <dt>이름</dt><dd>${esc(p.name)}</dd><dt>학생 번호</dt><dd>${esc(p.code)}</dd><dt>등록 전화번호</dt><dd>${esc(p.phone)}</dd></dl>
    <p class="small muted mt">이름·전화번호 변경이 필요하면 운영자에게 문의해주세요.</p>
    <button class="btn mt" id="lo">로그아웃</button></div>`;
  $('#lo').addEventListener('click', logout);
}, { auth: 'STUDENT', narrow: true });
