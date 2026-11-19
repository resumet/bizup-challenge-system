'use strict';
/* ===== 강사·관리자 화면 ===== */
const courseName = (c) => `${esc(c.title)} <span class="badge">${esc(c.cohort_label)}</span>`;

/* 대시보드 (관리자) */
route('/a/dashboard', async () => {
  const [d, list] = await Promise.all([GET('/api/admin/dashboard'), GET('/api/courses')]);
  const stat = (num, label) => `<div class="card stat"><div class="num">${num}</div><div class="label">${label}</div></div>`;
  APP().innerHTML = `<h1>전체 대시보드</h1><p class="muted small mb">${esc(d.note)}</p>
    <div class="grid cards">
      ${stat(`${d.courses.READY} / ${d.courses.ACTIVE} / ${d.courses.ENDED}`, '준비 중 / 진행 중 / 종료 강의')}
      ${stat(d.active_instructors, '활성 강사')}
      ${stat(d.unique_students, `고유 수강생 (전체 ${d.total_students})`)}
      ${stat(d.active_enrollments, '활성 수강 등록')}
      ${stat(d.running_challenges, '진행 중 챌린지')}
      ${stat(`${d.progress.completed} / ${d.progress.target}`, `완료 / 대상 과제 건수 (${pctText(d.progress.rate)})`)}
      ${stat(d.progress.not_started, '미시작 건수')}
      ${stat(d.progress.need_submission, '필수 제출 필요')}
      ${stat(d.progress.late, '기한 후 완료')}
    </div>
    <h2 class="mt">강의 현황</h2><div id="course-table"></div>`;
  $('#course-table').appendChild(courseTable(list.items));
}, { auth: 'ADMIN' });

function courseTable(items) {
  const div = document.createElement('div');
  div.className = 'table-wrap';
  div.innerHTML = `<table><thead><tr><th>강의 번호</th><th>강의명·기수</th><th>강사</th><th>상태</th><th class="num">활성 수강생</th><th class="num">챌린지</th><th class="num">완료/대상</th><th class="num">진행률</th></tr></thead>
    <tbody>${items.map((c) => `<tr class="click" data-href="#/a/c/${c.id}/overview">
      <td>${esc(c.code)}</td><td>${courseName(c)}</td>
      <td>${c.instructors.map((i) => esc(i.name)).join(', ') || '<span class="badge danger">강사 미배정</span>'}</td>
      <td>${courseStateBadge(c.state)}</td><td class="num">${c.stats.active_students}</td><td class="num">${c.stats.challenges}</td>
      <td class="num">${c.stats.target ? `${c.stats.completed}/${c.stats.target}` : (c.stats.active_students ? '과제 없음' : '수강생 없음')}</td><td class="num">${pctText(c.stats.rate)}</td></tr>`).join('')
      || '<tr><td colspan="8" class="center muted">등록된 강의가 없습니다.</td></tr>'}</tbody></table>`;
  $$('tr[data-href]', div).forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
  return div;
}

/* 강의 목록 */
route('/a/courses', async (_p, q) => {
  const list = await GET('/api/courses' + qs({ q: q.q, state: q.state, instructor_q: q.instructor_q, include_archived: q.state ? undefined : q.archived }));
  APP().innerHTML = `<div class="row between mb"><h1>${ME.isAdmin ? '강의 목록' : '내 강의'}</h1>${ME.isAdmin ? '<button class="btn primary" id="new-course">+ 강의 생성</button>' : ''}</div>
    <form class="filters" id="flt">
      <input type="search" name="q" placeholder="강의명·기수·번호" value="${esc(q.q || '')}">
      ${ME.isAdmin ? `<input type="search" name="instructor_q" placeholder="강사 이름" value="${esc(q.instructor_q || '')}">` : ''}
      <select name="state"><option value="">상태 전체(보관 제외)</option>${Object.entries(COURSE_STATE).map(([k, v]) => `<option value="${k}" ${q.state === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button class="btn" type="submit">검색</button></form><div id="tbl"></div>`;
  $('#tbl').appendChild(courseTable(list.items));
  $('#flt').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/a/courses' + qs(formData(e.target)); });
  if (ME.isAdmin) $('#new-course').addEventListener('click', () => courseFormModal());
}, { auth: 'STAFF' });

async function courseFormModal(course) {
  const ins = course ? null : (await GET('/api/instructors')).items;
  const c = course || {};
  const m = modal(`<h2>${course ? '강의 정보 수정' : '강의 생성'}</h2><form id="cf">
    <div class="field"><label>강의명 *</label><input type="text" name="title" value="${esc(c.title || '')}" required maxlength="200"></div>
    <div class="field"><label>기수명 *</label><input type="text" name="cohort_label" value="${esc(c.cohort_label || '')}" placeholder="예: 1기, 2027년 1월반" required maxlength="100">
      <div class="hint">같은 내용의 강의라도 기수마다 별도 강의로 만들어 고유번호가 부여됩니다.</div></div>
    <div class="field"><label>소개 (수강생에게 표시)</label><textarea name="description">${esc(c.description || '')}</textarea></div>
    <div class="row"><div class="field grow"><label>시작일</label><input type="date" name="starts_on" value="${esc(c.starts_on || '')}"></div>
      <div class="field grow"><label>종료일</label><input type="date" name="ends_on" value="${esc(c.ends_on || '')}"></div></div>
    <div class="field"><label>운영 상태</label><select name="state">${Object.entries(COURSE_STATE).map(([k, v]) => `<option value="${k}" ${(c.state || 'READY') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <div class="hint">종료·보관 상태여도 활성 수강생의 열람 권한은 유지됩니다.</div></div>
    ${ins ? `<div class="field"><label>배정 강사</label>${ins.length ? ins.map((i) => `<label class="inline"><input type="checkbox" name="ins" value="${i.id}"> ${esc(i.name)} <span class="small muted">${esc(i.code)} · ${esc(i.email)}</span></label>`).join('<br>') : '<p class="small muted">등록된 강사가 없습니다. 강사 관리에서 먼저 강사를 등록하세요.</p>'}</div>` : ''}
    <div class="field"><label>내부 메모 (관리자 전용)</label><textarea name="admin_memo">${esc(c.admin_memo || '')}</textarea></div>
    <p class="form-error small" style="color:var(--danger)"></p>
    <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
  bindForm($('#cf', m.el), async (d, form) => {
    const body = { title: d.title, cohort_label: d.cohort_label, description: d.description, starts_on: d.starts_on || null, ends_on: d.ends_on || null, state: d.state, admin_memo: d.admin_memo };
    if (course) {
      body.version = course.version;
      await PATCH('/api/courses/' + course.id, body);
      m.close(); toast('저장되었습니다.'); rerender();
    } else {
      body.instructor_ids = $$('input[name=ins]:checked', form).map((x) => x.value);
      let res;
      try { res = await POST('/api/courses', body); } catch (e) {
        if (e.body && e.body.reason === 'POSSIBLE_DUPLICATE' && await confirmModal(e.message, { okText: '그래도 생성' })) res = await POST('/api/courses', { ...body, confirm_duplicate: true });
        else throw e;
      }
      m.close(); toast(`강의가 생성되었습니다. (${res.code})`); location.hash = `#/a/c/${res.id}/overview`;
    }
  });
}

/* 강의 상세 */
const COURSE_TABS = [['overview', '개요'], ['students', '수강생'], ['challenges', '챌린지'], ['progress', '진행 현황'], ['logs', '이력']];
route('/a/c/:id/:tab', async ({ id, tab }, q) => {
  const c = await GET('/api/courses/' + id);
  APP().innerHTML = `<div class="breadcrumb"><a href="#/a/courses">${ME.isAdmin ? '강의 목록' : '내 강의'}</a> ›</div>
    <div class="row between"><div><h1>${courseName(c)}</h1><div class="small muted">${esc(c.code)} · ${courseStateBadge(c.state)} · 강사 ${c.instructors.map((i) => esc(i.name)).join(', ') || '없음'}</div></div></div>
    ${c.no_instructor_warning ? '<p class="notice danger mt">진행 중인 강의에 배정된 강사가 없습니다.</p>' : ''}
    <nav class="tabs">${COURSE_TABS.map(([k, v]) => `<a href="#/a/c/${id}/${k}" class="${tab === k ? 'on' : ''}">${v}</a>`).join('')}</nav><div id="tab"></div>`;
  const el = $('#tab');
  if (tab === 'overview') return courseOverview(el, c);
  if (tab === 'students') return courseStudents(el, c, q);
  if (tab === 'challenges') return courseChallenges(el, c);
  if (tab === 'progress') return courseProgress(el, c, q);
  if (tab === 'logs') return auditList(el, { course_id: c.id }, q, `#/a/c/${c.id}/logs`);
}, { auth: 'STAFF' });

async function courseOverview(el, c) {
  const s = c.stats;
  el.innerHTML = `<div class="grid two">
    <div class="card"><div class="row between"><h2>강의 정보</h2>${ME.isAdmin ? '<button class="btn sm" id="edit">수정</button>' : ''}</div>
      <dl class="kv"><dt>강의 번호</dt><dd>${esc(c.code)}</dd><dt>강의명</dt><dd>${esc(c.title)}</dd><dt>기수</dt><dd>${esc(c.cohort_label)}</dd>
      <dt>일정</dt><dd>${esc(c.starts_on || '-')} ~ ${esc(c.ends_on || '-')}</dd><dt>운영 상태</dt><dd>${courseStateBadge(c.state)}</dd>
      <dt>소개</dt><dd class="pre">${esc(c.description || '-')}</dd>${ME.isAdmin ? `<dt>내부 메모</dt><dd class="pre">${esc(c.admin_memo || '-')}</dd>` : ''}</dl></div>
    <div class="card"><h2>집계</h2><dl class="kv"><dt>활성 수강생</dt><dd>${s.active_students}명</dd><dt>챌린지</dt><dd>${s.challenges}개</dd>
      <dt>공개 과제</dt><dd>${s.published_assignments}개</dd><dt>완료/대상</dt><dd>${s.target ? `${s.completed} / ${s.target} (${pctText(s.rate)})` : (s.active_students ? '과제 없음' : '수강생 없음')}</dd>
      <dt>미시작</dt><dd>${s.not_started}건</dd><dt>제출 필요</dt><dd>${s.need_submission}건</dd><dt>기한 후 완료</dt><dd>${s.late}건</dd></dl>
      ${s.target ? `<div class="mt">${progressBar(s.rate)}</div>` : ''}</div>
    <div class="card"><h2>공동 강사</h2><ul class="list">${c.instructors.map((i) => `<li class="row between"><span>${esc(i.name)} <span class="small muted">${esc(i.code)} · ${esc(i.email)}</span>${i.account_status !== 'ACTIVE' ? ` <span class="badge warn">${i.account_status === 'PENDING' ? '설정 대기' : '비활성'}</span>` : ''}</span>
      ${ME.isAdmin ? `<button class="btn sm danger" data-unassign="${i.id}">배정 해제</button>` : ''}</li>`).join('') || '<li class="muted">배정된 강사가 없습니다.</li>'}</ul>
      ${ME.isAdmin ? '<div class="row mt"><select id="ins-sel" class="grow"><option value="">강사 선택…</option></select><button class="btn" id="assign">배정</button></div>' : ''}</div>
  </div>`;
  if (!ME.isAdmin) return;
  $('#edit').addEventListener('click', () => courseFormModal(c));
  const all = (await GET('/api/instructors')).items.filter((i) => !c.instructors.some((x) => x.id === i.id));
  $('#ins-sel').innerHTML += all.map((i) => `<option value="${i.id}">${esc(i.name)} (${esc(i.code)} · ${esc(i.email)})</option>`).join('');
  $('#assign').addEventListener('click', async () => {
    const v = $('#ins-sel').value; if (!v) return;
    try { await PUT(`/api/courses/${c.id}/instructors/${v}`); toast('배정했습니다.'); rerender(); } catch (e) { toast(errMsg(e), true); }
  });
  $$('[data-unassign]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('배정을 해제하면 이 강의에 대한 강사 권한만 회수됩니다. 작성한 과제·피드백은 유지됩니다.', { okText: '해제', danger: true }))) return;
    try { const r = await DEL(`/api/courses/${c.id}/instructors/${b.dataset.unassign}`); if (r.no_instructor_warning) toast('진행 중인 강의에 강사가 없습니다.', true); else toast('해제했습니다.'); rerender(); } catch (e) { toast(errMsg(e), true); }
  }));
}

async function courseStudents(el, c, q) {
  const page = Number(q.page) || 1; const size = Number(q.size) || 50;
  const data = await GET(`/api/courses/${c.id}/enrollments` + qs({ q: q.q, status: q.status, page, size }));
  const go = (p) => { location.hash = `#/a/c/${c.id}/students` + qs({ ...q, ...p }); };
  // 등록 방법: 관리자(개별·기존 학생 연결·엑셀·외부 API), 담당 강사(개별·엑셀)
  el.innerHTML = `<div class="row between mb">
      <form class="filters" id="flt" style="margin:0"><input type="search" name="q" placeholder="이름·학생번호${ME.isAdmin ? '·전화번호' : '·전화번호 4자리 이상'}" value="${esc(q.q || '')}">
      <select name="status"><option value="ACTIVE">활성 등록</option><option value="INACTIVE" ${q.status === 'INACTIVE' ? 'selected' : ''}>비활성 이력</option><option value="ALL" ${q.status === 'ALL' ? 'selected' : ''}>전체</option></select>
      <button class="btn" type="submit">검색</button></form>
      <div class="row"><a class="btn" href="/api/import-template.csv">양식 다운로드</a><button class="btn primary" id="upload">엑셀 업로드</button><button class="btn" id="add">개별 등록</button>
      ${ME.isAdmin ? '<button class="btn" id="link">기존 학생 연결</button><button class="btn" id="api-import">외부 API 가져오기</button>' : ''}</div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>학생 번호</th><th>이름</th><th>전화번호</th><th>상태</th><th class="num">완료/공개 과제</th><th class="num">미확인 피드백</th><th></th></tr></thead>
    <tbody>${data.items.map((e) => `<tr class="click" data-href="#/a/e/${e.id}">
      <td>${esc(e.student.code)}</td><td>${esc(e.student.name)}</td><td>${esc(e.student.phone)}</td>
      <td>${e.status === 'ACTIVE' ? '<span class="badge ok">활성</span>' : `<span class="badge danger">비활성</span>${e.reason ? ` <span class="small muted">${esc(e.reason)}</span>` : ''}`}${e.student.status !== 'ACTIVE' ? ' <span class="badge danger">학생 비활성</span>' : ''}</td>
      <td class="num">${e.progress.total ? `${e.progress.completed}/${e.progress.total} (${pctText(e.progress.rate)})` : '과제 없음'}</td>
      <td class="num">${e.unread_feedback || ''}</td>
      <td class="num nowrap"><button class="btn sm" data-edit="${e.id}">수정</button>
        <button class="btn sm ${e.status === 'ACTIVE' ? 'danger' : ''}" data-toggle="${e.id}" data-status="${e.status}">${e.status === 'ACTIVE' ? '비활성화' : '재활성화'}</button>
        <button class="btn sm danger" data-del="${e.id}">삭제</button></td></tr>`).join('')
      || `<tr><td colspan="7" class="center muted">${q.q ? '검색 결과가 없습니다.' : '수강생 없음'}</td></tr>`}</tbody></table></div>`;
  el.appendChild(pagination(data.total, data.page, data.size, (p, s) => go({ page: p, size: s })));
  $('#flt').addEventListener('submit', (e) => { e.preventDefault(); go({ ...formData(e.target), page: 1 }); });
  $$('tr[data-href]', el).forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('button')) return; location.hash = tr.dataset.href; }));
  const byId = (id) => data.items.find((x) => x.id === id);
  $$('[data-toggle]', el).forEach((b) => b.addEventListener('click', () => toggleEnrollment(b.dataset.toggle, b.dataset.status)));
  $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => editEnrollmentStudent(byId(b.dataset.edit))));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => deleteEnrollment(byId(b.dataset.del))));
  $('#add').addEventListener('click', () => {
    const m = modal(`<h2>개별 등록</h2><p class="small muted">${courseName(c)}</p><form id="af">
      <div class="field"><label>이름 *</label><input type="text" name="name" required maxlength="50"></div>
      <div class="field"><label>전화번호 *</label><input type="tel" name="phone" required placeholder="010-1234-5678"><div class="hint">같은 번호의 기존 학생이 있으면 해당 학생을 이 강의에 연결합니다. 학생은 이름과 전화번호로 로그인합니다.</div></div>
      ${ME.isAdmin ? '<div class="field"><label>수강 등록 메모 (관리자 전용)</label><input type="text" name="memo" maxlength="1000"></div>' : ''}
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">등록</button></div></form>`);
    bindForm($('#af', m.el), async (d) => {
      try { const r = await POST(`/api/courses/${c.id}/enrollments`, d); m.close(); toast(`${r.student.name} (${r.student.code}) 등록 완료`); rerender(); } catch (e) {
        if (e.body && e.body.reason === 'NEEDS_REACTIVATION' && await confirmModal(e.message + '\n지금 재활성화할까요?', { okText: '재활성화' })) {
          await PATCH(`/api/enrollments/${e.body.enrollment_id}/status`, { status: 'ACTIVE', reason: '개별 등록 시 재활성화' }); m.close(); toast('재활성화했습니다.'); rerender(); return;
        }
        throw e;
      }
    });
  });
  $('#upload').addEventListener('click', () => {
    const m = modal(`<h2>엑셀로 명단 등록</h2><p class="small">대상 강의: ${courseName(c)}</p>
      <p class="small muted">.xlsx 또는 .csv (최대 10MB, 5,000행). 필수 열: 이름, 전화번호${ME.isAdmin ? ' / 선택 열: 수강 등록 메모' : ''}. 전화번호 열은 텍스트 형식으로 저장해주세요. 미리보기 단계에서는 실제 등록이 일어나지 않습니다.</p>
      <form id="uf"><div class="field"><input type="file" name="file" accept=".xlsx,.csv" required></div>
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">미리보기</button></div></form>`);
    bindForm($('#uf', m.el), async (_d, form) => {
      const f = await uploadFile(form.file.files[0], 'roster');
      const job = await POST(`/api/courses/${c.id}/imports/preview`, { file_id: f.id });
      m.close(); location.hash = '#/a/import/' + job.id;
    });
  });
  if (!ME.isAdmin) return;
  $('#link').addEventListener('click', () => {
    const m = modal(`<h2>기존 학생 연결</h2><form id="sf" class="row"><input class="grow" type="search" name="q" placeholder="이름·학생번호·전화번호" required><button class="btn" type="submit">검색</button></form><ul class="list mt" id="sr"></ul>
      <div class="actions"><button class="btn" data-close>닫기</button></div>`, { wide: true });
    $('#sf', m.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await GET('/api/students' + qs({ q: e.target.q.value, size: 20 }));
      $('#sr', m.el).innerHTML = r.items.map((s) => `<li class="row between"><span>${esc(s.code)} · <strong>${esc(s.name)}</strong> · ${esc(s.phone)} ${s.status !== 'ACTIVE' ? '<span class="badge danger">비활성</span>' : ''}</span><button class="btn sm" data-sid="${s.id}">이 강의에 연결</button></li>`).join('') || '<li class="muted">검색 결과가 없습니다.</li>';
      $$('[data-sid]', m.el).forEach((b) => b.addEventListener('click', async () => {
        try { await POST(`/api/courses/${c.id}/enrollments`, { student_id: b.dataset.sid }); toast('연결했습니다.'); m.close(); rerender(); } catch (ex) { toast(errMsg(ex), true); }
      }));
    });
  });
  $('#api-import').addEventListener('click', async () => {
    const sources = (await GET('/api/roster-sources')).items.filter((s) => s.status === 'ACTIVE');
    if (!sources.length) {
      if (await confirmModal('등록된 외부 연동 소스가 없습니다. 연동 소스를 먼저 등록할까요?', { okText: '외부 연동 설정으로' })) location.hash = '#/a/sources';
      return;
    }
    const m = modal(`<h2>외부 API에서 명단 가져오기</h2><p class="small">대상 강의: ${courseName(c)} <span class="muted">(${esc(c.code)})</span></p>
      <form id="pf"><div class="field"><label>연동 소스 *</label><select name="source_id" required>${sources.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>추가 값 <span class="muted">{param}</span></label><input type="text" name="param" maxlength="200" placeholder="예: 외부 시스템의 상품 번호"><div class="hint">연동 소스 주소·본문에 {param}이 있으면 이 값으로 바뀝니다. {course_code}는 이 강의 번호로 자동 입력됩니다.</div></div>
      <p class="small muted">가져온 명단은 엑셀 업로드와 같은 미리보기 화면에서 확인한 뒤 등록을 확정합니다.</p>
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">가져와서 미리보기</button></div></form>`);
    bindForm($('#pf', m.el), async (d) => {
      const job = await POST(`/api/courses/${c.id}/imports/api`, d);
      m.close(); location.hash = '#/a/import/' + job.id;
    });
  });
}
// 수강생 이름·전화번호 수정 (관리자·담당 강사). 학생 정보는 모든 강의에서 공유된다.
function editEnrollmentStudent(e) {
  const m = modal(`<h2>수강생 정보 수정</h2><p class="small muted">${esc(e.student.code)} · 현재 전화번호 ${esc(e.student.phone)}</p><form id="ef">
    <div class="field"><label>이름 *</label><input type="text" name="name" value="${esc(e.student.name)}" required maxlength="50"></div>
    <div class="field"><label>새 전화번호</label><input type="tel" name="phone" placeholder="바꿀 때만 입력 (예: 010-1234-5678)"></div>
    <div class="field"><label>변경 사유 *</label><input type="text" name="reason" required maxlength="500" placeholder="예: 전화번호 오타"></div>
    <p class="notice warn small">이름·전화번호는 학생의 로그인 정보입니다. 바꾸면 학생은 새 정보로 다시 로그인해야 하고, 이 학생이 수강하는 모든 강의에 반영됩니다.${ME.isAdmin ? '' : ' 다른 강사의 강의에도 등록된 학생은 관리자만 수정할 수 있습니다.'}</p>
    <p class="form-error small" style="color:var(--danger)"></p>
    <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
  bindForm($('#ef', m.el), async (d) => {
    const r = await PATCH(`/api/enrollments/${e.id}/student`, { name: d.name, phone: d.phone || undefined, reason: d.reason });
    m.close(); toast(r.changed === false ? '바뀐 내용이 없습니다.' : '수정했습니다.'); rerender();
  });
}
// 수강 등록 삭제: 수행 기록이 없을 때만. 기록이 있으면 비활성화를 안내한다.
async function deleteEnrollment(e, onDeleted = rerender) {
  if (!(await confirmModal(`${e.student.name} (${e.student.code}) 수강생의 이 강의 등록을 삭제할까요?\n잘못 등록한 경우에 사용합니다. 다른 강의 등록이 없으면 학생 정보도 함께 삭제되며 되돌릴 수 없습니다.`, { okText: '삭제', danger: true }))) return;
  try {
    const r = await DEL(`/api/enrollments/${e.id}`);
    toast(r.student_deleted ? '등록과 학생 정보를 삭제했습니다.' : '이 강의 등록을 삭제했습니다.'); onDeleted();
  } catch (ex) {
    if (ex.body && ex.body.reason === 'HAS_ACTIVITY') {
      if (e.status === 'ACTIVE' && await confirmModal(ex.message + '\n지금 비활성화할까요?', { okText: '비활성화로 진행' })) toggleEnrollment(e.id, 'ACTIVE');
      else if (e.status !== 'ACTIVE') toast(ex.message, true);
      return;
    }
    toast(errMsg(ex), true);
  }
}
async function toggleEnrollment(id, status) {
  if (status === 'ACTIVE') {
    const m = modal(`<h2>수강 등록 비활성화</h2><p class="small">비활성화하면 이 강의의 자료·과제·제출물·피드백 접근이 즉시 차단됩니다. 다른 강의 등록과 기록은 유지됩니다. 실제 환불 처리와는 별개입니다.</p>
      <form id="df"><div class="field"><label>사유 *</label><select name="preset"><option>환불</option><option>중도탈퇴</option><option>오등록</option><option value="">기타(직접 입력)</option></select></div>
      <div class="field"><input type="text" name="detail" placeholder="상세 사유 (선택)" maxlength="400"></div>
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn danger" type="submit">비활성화</button></div></form>`);
    bindForm($('#df', m.el), async (d) => {
      const reason = [d.preset, d.detail].filter(Boolean).join(' - ');
      await PATCH(`/api/enrollments/${id}/status`, { status: 'INACTIVE', reason }); m.close(); toast('비활성화했습니다.'); rerender();
    });
  } else {
    if (!(await confirmModal('같은 수강 등록과 기존 기록을 복원합니다. 마감된 챌린지는 해당 챌린지 설정을 따릅니다.', { okText: '재활성화' }))) return;
    try { await PATCH(`/api/enrollments/${id}/status`, { status: 'ACTIVE', reason: '재활성화' }); toast('재활성화했습니다.'); rerender(); } catch (e) { toast(errMsg(e), true); }
  }
}

/* 명단 업로드 미리보기·확정 */
const CLS = {
  NEW: ['신규 학생', 'ok'], EXISTING_NEW_ENROLLMENT: ['기존 학생·신규 등록', 'primary'], ALREADY_ENROLLED: ['이미 등록됨', ''],
  DUP_IN_FILE: ['파일 내 중복', ''], CONFLICT_IN_FILE: ['파일 내 충돌', 'danger'], NAME_CONFLICT: ['이름 충돌', 'danger'],
  NEEDS_REACTIVATION: ['재활성화 필요', 'warn'], STUDENT_INACTIVE: ['비활성 학생', 'warn'], ERROR: ['오류', 'danger'], EXCLUDED: ['제외됨', ''], PENDING: ['대기', ''],
};
const RESULT = { CREATED: ['생성', 'ok'], LINKED: ['연결', 'primary'], SKIPPED: ['건너뜀', ''], FAILED: ['실패', 'danger'] };
route('/a/import/:id', async ({ id }, q) => {
  const job = await GET('/api/imports/' + id);
  const filter = q.f || 'ALL';
  const rows = job.rows.filter((r) => filter === 'ALL' || (filter === 'ISSUE' ? !['NEW', 'EXISTING_NEW_ENROLLMENT'].includes(r.classification) : r.classification === filter));
  const committed = job.state === 'COMMITTED';
  const isApi = job.source_type === 'API';
  const label = isApi ? '외부 API 명단' : '명단 업로드';
  APP().innerHTML = `<div class="breadcrumb"><a href="#/a/c/${job.course_id}/students">${esc(job.course_title)} ${esc(job.cohort_label)}</a> › ${label}</div>
    <h1>${label} ${committed ? '결과' : job.state === 'COMMITTING' ? '처리 중' : '미리보기'}</h1>
    <p class="small muted">${isApi ? '출처' : '파일'}: ${esc(job.original_name)} · 대상 강의: ${esc(job.course_code)} ${esc(job.course_title)} ${esc(job.cohort_label)}</p>
    ${job.state === 'PREVIEW' && isApi ? `<div class="card small">응답 필드: 이름 <code>${esc(job.mapping.name)}</code> · 전화번호 <code>${esc(job.mapping.phone)}</code>${job.mapping.memo ? ` · 메모 <code>${esc(job.mapping.memo)}</code>` : ''}
      ${ME.isAdmin ? ' — 필드가 맞지 않으면 <a href="#/a/sources">외부 연동</a>에서 고친 뒤 다시 가져오세요.' : ''}</div>` : ''}
    ${job.state === 'PREVIEW' && !isApi ? `<div class="card"><h3>시트·열 매핑</h3><form id="mf" class="row">
      <label class="inline">시트 <select name="sheet">${job.sheet_names.map((s) => `<option ${s === job.sheet_name ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      ${['name', 'phone', 'memo'].map((k) => `<label class="inline">${{ name: '이름 *', phone: '전화번호 *', memo: '메모' }[k]} <select name="${k}"><option value="">(없음)</option>${job.headers.map((h, i) => `<option value="${i}" ${job.mapping[k] === i || String(job.mapping[k]) === String(i) ? 'selected' : ''}>${esc(h || `${i + 1}열`)}</option>`).join('')}</select></label>`).join('')}
      <button class="btn" type="submit">다시 검사</button></form>
      ${job.mapping.name == null || job.mapping.phone == null ? '<p class="notice warn mt small">이름·전화번호 열을 선택한 뒤 다시 검사해주세요.</p>' : ''}</div>` : ''}
    ${committed && job.result_counts ? `<div class="card"><h3>처리 결과</h3><div class="row">${Object.entries(job.result_counts).map(([k, v]) => `<span class="badge ${RESULT[k.toUpperCase()][1]}">${RESULT[k.toUpperCase()][0]} ${v}</span>`).join('')}</div></div>` : ''}
    ${job.state === 'COMMITTING' ? `<p class="notice">명단을 등록하는 중입니다… (${job.progress.processed}/${job.progress.total}행) 이 화면을 떠났다가 돌아오면 남은 행부터 이어서 처리합니다.</p>` : ''}
    <div class="card"><div class="row between"><div class="row">${Object.entries(job.preview_counts).map(([k, v]) => `<a class="badge ${CLS[k][1]}" href="#/a/import/${id}?f=${k}">${CLS[k][0]} ${v}</a>`).join('')}
      <a class="badge" href="#/a/import/${id}?f=ISSUE">확인 필요만</a><a class="badge" href="#/a/import/${id}">전체</a></div>
      ${job.state === 'PREVIEW' ? `<button class="btn primary" id="commit" ${job.committable ? '' : 'disabled'}>${job.committable}건 등록 확정</button>` : ''}</div>
      <p class="small muted">신규 학생·기존 학생 신규 등록 행만 등록됩니다. 충돌·오류 행은 수정하거나 제외하세요. 업로드 명단에서 빠진 학생은 자동 삭제·비활성화되지 않습니다.</p></div>
    <div class="table-wrap mt"><table><thead><tr><th>행</th><th>이름</th><th>전화번호</th><th>메모</th><th>분류</th><th>사유</th>${committed ? '<th>결과</th>' : '<th></th>'}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${r.row_number}</td><td>${esc(r.raw_name)}</td><td>${esc(r.phone || r.raw_phone)}</td><td class="small">${esc(r.memo || '')}</td>
      <td><span class="badge ${CLS[r.classification][1]}">${CLS[r.classification][0]}</span></td><td class="small">${esc(r.error || '')}</td>
      ${committed ? `<td>${r.result ? `<span class="badge ${RESULT[r.result][1]}">${RESULT[r.result][0]}</span> <span class="small muted">${esc(r.result_message || '')}</span>` : ''}</td>`
    : job.state === 'PREVIEW' ? `<td class="num"><button class="btn sm" data-edit="${r.row_number}">수정</button> <button class="btn sm" data-excl="${r.row_number}" data-v="${r.excluded ? 0 : 1}">${r.excluded ? '포함' : '제외'}</button></td>` : '<td></td>'}</tr>`).join('')
      || '<tr><td colspan="7" class="center muted">표시할 행이 없습니다.</td></tr>'}</tbody></table></div>`;
  // 서버리스 실행 시간 제한 때문에 서버는 호출마다 일부 행만 처리한다. 화면에 머무는 동안 이어서 요청한다(멱등).
  if (job.state === 'COMMITTING') {
    setTimeout(async () => {
      if (!location.hash.startsWith('#/a/import/' + id)) return;
      try { await POST(`/api/imports/${id}/commit`, { idempotency_key: id }); } catch (e) { toast(errMsg(e), true); }
      rerender();
    }, 300);
    return;
  }
  if (job.state !== 'PREVIEW') return;
  if ($('#mf')) $('#mf').addEventListener('submit', async (e) => {
    e.preventDefault(); const d = formData(e.target);
    try { await POST(`/api/imports/${id}/remap`, { sheet: d.sheet, mapping: { name: d.name, phone: d.phone, memo: d.memo } }); rerender(); } catch (ex) { toast(errMsg(ex), true); }
  });
  $$('[data-excl]').forEach((b) => b.addEventListener('click', async () => {
    try { await PATCH(`/api/imports/${id}/rows/${b.dataset.excl}`, { excluded: b.dataset.v === '1' }); rerender(); } catch (e) { toast(errMsg(e), true); }
  }));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const r = job.rows.find((x) => String(x.row_number) === b.dataset.edit);
    const m = modal(`<h2>${r.row_number}행 수정</h2><form id="rf">
      <div class="field"><label>이름</label><input type="text" name="name" value="${esc(r.raw_name)}"></div>
      <div class="field"><label>전화번호</label><input type="text" name="phone" value="${esc(r.raw_phone)}"></div>
      <div class="field"><label>메모</label><input type="text" name="memo" value="${esc(r.memo || '')}"></div>
      <p class="small muted">기존 학생의 이름·전화번호는 명단 업로드로 덮어쓰지 않습니다. 기존 정보가 틀렸다면 수강생 목록의 수정 기능${ME.isAdmin ? '이나 전체 학생 관리' : ''}에서 정정하세요.</p>
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">다시 검사</button></div></form>`);
    bindForm($('#rf', m.el), async (d) => { await PATCH(`/api/imports/${id}/rows/${r.row_number}`, d); m.close(); rerender(); });
  }));
  $('#commit').addEventListener('click', async () => {
    if (!(await confirmModal(`${job.committable}건을 ${job.course_title} ${job.cohort_label}에 등록합니다. 확정 시점에 중복 여부를 다시 검사합니다.`, { okText: '등록 확정' }))) return;
    try { await POST(`/api/imports/${id}/commit`, { idempotency_key: id }); rerender(); } catch (e) { toast(errMsg(e), true); }
  });
}, { auth: 'STAFF' });

/* 외부 명단 API 연동 소스 (관리자) */
route('/a/sources', async () => {
  const { items } = await GET('/api/roster-sources');
  APP().innerHTML = `<div class="row between mb"><h1>외부 명단 연동</h1><button class="btn primary" id="new-src">+ 연동 소스 추가</button></div>
    <p class="small muted">결제·회원 시스템 등 외부 DB의 API에서 수강생 명단을 가져옵니다. 강의의 수강생 탭에서 <strong>외부 API 가져오기</strong>로 사용하며, 가져온 명단은 미리보기에서 확인한 뒤 확정해야 등록됩니다.</p>
    <div class="table-wrap"><table><thead><tr><th>이름</th><th>요청</th><th>필드 (이름 / 전화번호 / 메모)</th><th>인증 헤더</th><th>상태</th><th>마지막 사용</th><th></th></tr></thead><tbody>
    ${items.map((s) => `<tr><td><strong>${esc(s.name)}</strong></td><td class="small" style="word-break:break-all"><span class="badge">${esc(s.method)}</span> ${esc(s.url)}${s.items_path ? `<br><span class="muted">목록: ${esc(s.items_path)}</span>` : ''}</td>
      <td class="small"><code>${esc(s.name_field)}</code> / <code>${esc(s.phone_field)}</code> / ${s.memo_field ? `<code>${esc(s.memo_field)}</code>` : '-'}</td>
      <td class="small">${s.header_names.map((h) => `${esc(h)}: ••••`).join('<br>') || '-'}</td>
      <td>${s.status === 'ACTIVE' ? '<span class="badge ok">사용</span>' : '<span class="badge">중지</span>'}</td><td class="small">${s.last_used_at ? fmtDT(s.last_used_at) : '-'}</td>
      <td class="num nowrap"><button class="btn sm" data-test="${s.id}">연결 테스트</button> <button class="btn sm" data-edit="${s.id}">수정</button> <button class="btn sm danger" data-del="${s.id}">삭제</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="center muted">등록된 연동 소스가 없습니다.</td></tr>'}</tbody></table></div>`;
  $('#new-src').addEventListener('click', () => sourceModal());
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => sourceModal(items.find((x) => x.id === b.dataset.edit))));
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('연동 소스를 삭제할까요? 이미 등록된 수강생에는 영향이 없습니다.', { okText: '삭제', danger: true }))) return;
    try { await DEL('/api/roster-sources/' + b.dataset.del); toast('삭제했습니다.'); rerender(); } catch (e) { toast(errMsg(e), true); }
  }));
  $$('[data-test]').forEach((b) => b.addEventListener('click', () => sourceTestModal(items.find((x) => x.id === b.dataset.test))));
}, { auth: 'ADMIN' });

function sourceModal(src) {
  const s = src || { method: 'GET', header_names: [] };
  const headerRow = (name = '', saved = false) => `<div class="row hdr"><input type="text" class="grow" data-h="name" placeholder="헤더 이름 (예: Authorization)" value="${esc(name)}">
    <input type="password" class="grow" data-h="value" autocomplete="new-password" placeholder="${saved ? '저장된 값 유지 (바꿀 때만 입력)' : '값 (예: Bearer …)'}"><button type="button" class="btn sm" data-rm>삭제</button></div>`;
  const m = modal(`<h2>${src ? '연동 소스 수정' : '연동 소스 추가'}</h2><form id="sf">
    <div class="field"><label>이름 *</label><input type="text" name="name" value="${esc(s.name || '')}" required maxlength="100" placeholder="예: 결제 시스템 수강생 API"></div>
    <div class="row"><div class="field" style="width:110px"><label>방식</label><select name="method">${['GET', 'POST'].map((x) => `<option ${s.method === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field grow"><label>API 주소 *</label><input type="url" name="url" value="${esc(s.url || '')}" required placeholder="https://api.example.com/students?course={course_code}"></div></div>
    <div class="hint mb">자리표시자: <code>{course_code}</code> 강의 번호 · <code>{course_title}</code> 강의명 · <code>{cohort_label}</code> 기수 · <code>{param}</code> 가져올 때 입력하는 값. https 주소만 사용할 수 있습니다.</div>
    <div class="field"><label>인증 헤더</label><div id="hdrs">${s.header_names.map((h) => headerRow(h, true)).join('')}</div><button type="button" class="btn sm mt" id="add-h">+ 헤더 추가</button>
      <div class="hint">저장된 값은 다시 표시되지 않습니다.</div></div>
    <div class="field"><label>요청 본문 (POST, JSON)</label><textarea name="body_template" rows="3" placeholder='{"courseCode": "{course_code}"}'>${esc(s.body_template || '')}</textarea></div>
    <div class="field"><label>목록 위치</label><input type="text" name="items_path" value="${esc(s.items_path || '')}" placeholder="예: data.students (응답 자체가 배열이면 비움)"></div>
    <div class="row"><div class="field grow"><label>이름 필드 *</label><input type="text" name="name_field" value="${esc(s.name_field || '')}" required placeholder="예: name 또는 profile.name"></div>
      <div class="field grow"><label>전화번호 필드 *</label><input type="text" name="phone_field" value="${esc(s.phone_field || '')}" required placeholder="예: phone"></div>
      <div class="field grow"><label>메모 필드</label><input type="text" name="memo_field" value="${esc(s.memo_field || '')}" placeholder="선택"></div></div>
    ${src ? `<div class="field"><label class="inline"><input type="checkbox" name="active" ${s.status === 'ACTIVE' ? 'checked' : ''}> 사용</label></div>` : ''}
    <p class="form-error small" style="color:var(--danger)"></p>
    <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`, { wide: true });
  const bindRm = () => $$('[data-rm]', m.el).forEach((b) => { b.onclick = () => b.closest('.hdr').remove(); });
  $('#add-h', m.el).addEventListener('click', () => { $('#hdrs', m.el).insertAdjacentHTML('beforeend', headerRow()); bindRm(); });
  bindRm();
  bindForm($('#sf', m.el), async (d, form) => {
    const headers = $$('.hdr', form).map((row) => ({ name: $('[data-h=name]', row).value.trim(), value: $('[data-h=value]', row).value })).filter((h) => h.name);
    const body = { name: d.name, method: d.method, url: d.url, body_template: d.body_template, items_path: d.items_path, name_field: d.name_field, phone_field: d.phone_field, memo_field: d.memo_field, headers };
    if (src) { body.status = form.active.checked ? 'ACTIVE' : 'DISABLED'; await PATCH('/api/roster-sources/' + src.id, body); } else await POST('/api/roster-sources', body);
    m.close(); toast('저장했습니다.'); rerender();
  });
}

async function sourceTestModal(src) {
  const courses = (await GET('/api/courses')).items;
  const m = modal(`<h2>연결 테스트 — ${esc(src.name)}</h2><p class="small muted">실제로 API를 호출해 응답을 확인합니다. 수강생은 등록되지 않습니다.</p>
    <form id="tf" class="row"><select name="course_id" class="grow"><option value="">강의 선택 (자리표시자용, 선택)</option>${courses.map((c) => `<option value="${c.id}">${esc(c.code)} ${esc(c.title)} ${esc(c.cohort_label)}</option>`).join('')}</select>
      <input type="text" name="param" placeholder="{param} 값 (선택)"><button class="btn primary" type="submit">테스트</button></form>
    <p class="form-error small" style="color:var(--danger)"></p><div id="tr" class="mt"></div>
    <div class="actions"><button class="btn" data-close>닫기</button></div>`, { wide: true });
  bindForm($('#tf', m.el), async (d) => {
    const r = await POST(`/api/roster-sources/${src.id}/test`, d);
    $('#tr', m.el).innerHTML = `<p><strong>${r.total}명</strong> 응답 · 이름·전화번호가 올바른 행 <strong>${r.valid}명</strong></p>
      <p class="small muted">첫 항목의 필드: ${r.keys.map((k) => `<code>${esc(k)}</code>`).join(' ') || '-'}</p>
      <div class="table-wrap"><table><thead><tr><th>이름</th><th>전화번호</th><th>메모</th></tr></thead><tbody>${r.sample.map((x) => `<tr><td>${esc(x.name) || '<span class="badge danger">비어 있음</span>'}</td><td>${esc(x.phone) || '<span class="badge danger">비어 있음</span>'}</td><td class="small">${esc(x.memo || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="center muted">항목 없음</td></tr>'}</tbody></table></div>`;
  });
}

/* 챌린지 관리 */
async function courseChallenges(el, c) {
  const { items } = await GET(`/api/courses/${c.id}/challenges`);
  el.innerHTML = `<div class="row between mb"><p class="small muted" style="margin:0">챌린지 → 과제 → 해야 할 일 순서로 구성합니다. 공개 과제는 이 강의의 모든 수강생에게 공통 적용됩니다.</p>
    <button class="btn primary" id="new-ch">+ 새 챌린지</button></div>
    ${items.map((ch) => `<div class="card">
      <div class="row between"><div><h3 style="margin:0">${esc(ch.title)} ${ch.visibility === 'DRAFT' ? '<span class="badge warn">초안</span>' : '<span class="badge ok">공개</span>'} ${phaseBadge(ch.phase)}</h3>
        <div class="small muted">${esc(ch.start_date)} ~ ${esc(ch.end_date)} · 종료 후 ${ch.allow_after_deadline ? '<strong>수정 허용</strong>' : '마감'} · 공개 과제 ${ch.stats.published_assignments}개 · 완료 ${ch.stats.completed}/${ch.stats.target} (${pctText(ch.stats.rate)}) · 완주 ${ch.stats.finishers}명</div></div>
        <div class="row"><button class="btn sm" data-edit-ch="${ch.id}">수정</button><button class="btn sm" data-new-as="${ch.id}">+ 과제</button><button class="btn sm" data-lib="${ch.id}">기존 과제 복사</button><button class="btn sm danger" data-del-ch="${ch.id}">삭제</button></div></div>
      ${ch.description ? `<p class="small pre">${esc(ch.description)}</p>` : ''}
      ${ch.visibility === 'DRAFT' && ch.assignments.some((a) => a.visibility === 'PUBLISHED') ? `<div class="notice warn mt row between"><span>이 챌린지가 <strong>초안</strong>이라 공개한 과제도 수강생에게 보이지 않습니다.</span>
        <button class="btn sm primary" data-pub-ch="${ch.id}">챌린지 공개</button></div>` : ''}
      <div class="table-wrap mt"><table><thead><tr><th>과제</th><th>상태</th><th class="num">할 일</th><th>제출</th><th class="num">완료</th></tr></thead><tbody>
      ${ch.assignments.map((a) => `<tr class="click" data-href="#/a/as/${a.id}"><td>${esc(a.title)}${a.copied_from_id ? ' <span class="small muted">(복사본)</span>' : ''}</td>
        <td>${a.visibility === 'DRAFT' ? '<span class="badge warn">초안</span>' : '<span class="badge ok">공개</span>'} ${a.locked_at ? `<span class="badge" title="완료 조건 동결">${icon('lock')} 동결</span>` : ''}</td>
        <td class="num">${a.item_count}</td><td>${a.submission_required ? '필수' : '선택'}</td><td class="num">${a.completed}</td></tr>`).join('') || '<tr><td colspan="5" class="muted center">과제가 없습니다.</td></tr>'}
      </tbody></table></div></div>`).join('') || '<div class="card center muted">챌린지가 없습니다.</div>'}`;
  $$('tr[data-href]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
  $('#new-ch').addEventListener('click', () => challengeModal(c));
  $$('[data-pub-ch]').forEach((b) => b.addEventListener('click', async () => {
    const ch = items.find((x) => x.id === b.dataset.pubCh);
    if (!(await confirmModal(`'${ch.title}' 챌린지를 공개합니다.\n이 챌린지의 공개 과제가 모든 수강생에게 보이고 진행률에 반영됩니다.`, { okText: '챌린지 공개' }))) return;
    try { await PATCH('/api/challenges/' + ch.id, { visibility: 'PUBLISHED', version: ch.version }); toast('챌린지를 공개했습니다.'); rerender(); } catch (e) { toast(errMsg(e), true); }
  }));
  $$('[data-edit-ch]').forEach((b) => b.addEventListener('click', () => challengeModal(c, items.find((x) => x.id === b.dataset.editCh))));
  $$('[data-del-ch]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('챌린지와 소속 과제(초안 포함)를 삭제합니다. 학생 수행·피드백 이력이 있으면 삭제할 수 없습니다.', { okText: '삭제', danger: true }))) return;
    try { await DEL('/api/challenges/' + b.dataset.delCh); toast('삭제했습니다.'); rerender(); } catch (e) { toast(errMsg(e), true); }
  }));
  $$('[data-new-as]').forEach((b) => b.addEventListener('click', () => {
    const m = modal(`<h2>새 과제</h2><form id="nf"><div class="field"><label>과제 제목 *</label><input type="text" name="title" required maxlength="200"></div>
      <p class="small muted">초안으로 생성됩니다. 해야 할 일·자료를 추가한 뒤 공개하세요.</p><p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">생성</button></div></form>`);
    bindForm($('#nf', m.el), async (d) => { const a = await POST(`/api/challenges/${b.dataset.newAs}/assignments`, { title: d.title, items: [] }); m.close(); location.hash = '#/a/as/' + a.id; });
  }));
  $$('[data-lib]').forEach((b) => b.addEventListener('click', () => libraryModal(b.dataset.lib)));
}
function challengeModal(c, ch) {
  const x = ch || { allow_after_deadline: false, visibility: 'DRAFT' };
  const m = modal(`<h2>${ch ? '챌린지 수정' : '새 챌린지'}</h2><p class="small muted">${courseName(c)}</p><form id="chf">
    <div class="field"><label>챌린지 제목 *</label><input type="text" name="title" value="${esc(x.title || '')}" required maxlength="200"></div>
    <div class="field"><label>안내 설명</label><textarea name="description">${esc(x.description || '')}</textarea></div>
    <div class="row"><div class="field grow"><label>시작일 *</label><input type="date" name="start_date" value="${esc(x.start_date || '')}" required></div>
      <div class="field grow"><label>종료일 *</label><input type="date" name="end_date" value="${esc(x.end_date || '')}" required></div></div>
    <p class="hint">한국 시간 기준. 시작일 00:00부터 종료일 23:59:59까지 기한 내 수행입니다.</p>
    <div class="field"><label>종료 후 처리</label><select name="allow_after_deadline"><option value="0">마감 (조회만 가능)</option><option value="1" ${x.allow_after_deadline ? 'selected' : ''}>수정 허용 (체크·제출·수정 가능, 기한 후 완료로 표시)</option></select></div>
    <div class="field"><label>공개 상태</label><select name="visibility"><option value="DRAFT">초안 (강사·관리자만 확인)</option><option value="PUBLISHED" ${x.visibility === 'PUBLISHED' ? 'selected' : ''}>공개</option></select>
      <div class="hint">공개 챌린지는 시작 전에도 안내와 공개 과제가 학생에게 보이며, 체크·제출은 시작일부터 가능합니다.</div></div>
    <p class="form-error small" style="color:var(--danger)"></p>
    <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
  bindForm($('#chf', m.el), async (d) => {
    const body = { ...d, allow_after_deadline: d.allow_after_deadline === '1' };
    if (!ch) { await POST(`/api/courses/${c.id}/challenges`, body); m.close(); toast('저장되었습니다.'); rerender(); return; }
    body.version = ch.version;
    try { await PATCH('/api/challenges/' + ch.id, body); } catch (e) {
      if (e.body && e.body.reason === 'CONFIRM_SCHEDULE_CHANGE') {
        const im = e.body.impact;
        if (!(await confirmModal(`${e.message}\n영향받는 활성 수강생 ${im.students}명, 현재 완료 건수 ${im.completed}건.\n이미 기록된 완료의 기한 내·기한 후 구분은 바뀌지 않습니다.`, { okText: '변경' }))) return;
        await PATCH('/api/challenges/' + ch.id, { ...body, confirm_schedule_change: true });
      } else throw e;
    }
    m.close(); toast('저장되었습니다.'); rerender();
  });
}
async function libraryModal(targetChallengeId) {
  const m = modal(`<h2>기존 과제 복사해오기</h2><form id="lf" class="row"><input class="grow" type="search" name="q" placeholder="과제명·강의명"><button class="btn" type="submit">검색</button></form>
    <p class="small muted">할 일·자료·제출 설정이 복사되며 학생 기록·피드백은 복사되지 않습니다. 새 초안으로 만들어집니다.</p>
    <div class="table-wrap"><table><tbody id="lr"></tbody></table></div><div class="actions"><button class="btn" data-close>닫기</button></div>`, { wide: true });
  const load = async (q) => {
    const r = await GET('/api/assignment-library' + qs({ q }));
    $('#lr', m.el).innerHTML = r.items.map((a) => `<tr><td><strong>${esc(a.title)}</strong><div class="small muted">${esc(a.course_code)} ${esc(a.course_title)} ${esc(a.cohort_label)} › ${esc(a.challenge_title)} · 할 일 ${a.item_count}개 · 제출 ${a.submission_required ? '필수' : '선택'}</div></td>
      <td class="num"><button class="btn sm" data-copy="${a.id}">복사</button></td></tr>`).join('') || '<tr><td class="muted center">과제가 없습니다.</td></tr>';
    $$('[data-copy]', m.el).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const a = await POST(`/api/assignments/${b.dataset.copy}/copy`, { target_challenge_id: targetChallengeId, idempotency_key: uid() }); m.close(); toast('복사했습니다. 내용을 확인한 뒤 공개하세요.'); location.hash = '#/a/as/' + a.id; } catch (e) { b.disabled = false; toast(errMsg(e), true); }
    }));
  };
  $('#lf', m.el).addEventListener('submit', (e) => { e.preventDefault(); load(e.target.q.value); });
  load('');
}

/* 과제 편집 */
route('/a/as/:id', async ({ id }) => {
  const a = await GET('/api/assignments/' + id);
  renderAssignmentEditor(a);
}, { auth: 'STAFF' });
function renderAssignmentEditor(a) {
  const L = a.locked;
  APP().innerHTML = `<div class="breadcrumb"><a href="#/a/c/${a.course.id}/challenges">${esc(a.course.title)} ${esc(a.course.cohort_label)}</a> › ${esc(a.challenge.title)} ${a.challenge.visibility === 'DRAFT' ? '<span class="badge warn">챌린지 초안</span>' : ''}</div>
    <div class="row between"><h1>${esc(a.title)} ${a.visibility === 'DRAFT' ? '<span class="badge warn">초안</span>' : '<span class="badge ok">공개</span>'} ${L ? `<span class="badge">${icon('lock')} 동결</span>` : ''}</h1>
      <div class="row"><button class="btn" id="preview">학생 화면 미리보기</button><button class="btn" id="copy">복사</button>
      ${a.visibility === 'DRAFT' ? '<button class="btn primary" id="publish">공개</button>' : (a.has_history ? '' : '<button class="btn" id="unpublish">공개 취소</button>')}
      ${a.has_history ? '' : '<button class="btn danger" id="delete">삭제</button>'}</div></div>
    <p class="small muted">작성 ${esc(a.created_by_name || '-')} · 최종 수정 ${esc(a.updated_by_name || '-')} ${fmtDT(a.updated_at)}${a.copied_from ? ` · 원본: ${esc(a.copied_from.course_code)} ${esc(a.copied_from.title)}` : ''}</p>
    ${a.visibility === 'PUBLISHED' && a.challenge.visibility === 'DRAFT' ? `<div class="notice danger row between"><span>공개한 과제지만 <strong>소속 챌린지 '${esc(a.challenge.title)}'가 초안</strong>이라 수강생에게 보이지 않습니다.</span>
      <button class="btn sm primary" id="pub-ch">챌린지도 공개</button></div>` : ''}
    ${L ? `<p class="notice warn">수강생이 시작한 과제입니다(${fmtDT(a.locked_at)}). 해야 할 일과 제출 필수·선택 설정은 변경할 수 없습니다. 수행 조건을 바꾸려면 복사하여 새 과제로 만들어주세요. 제목·설명 오탈자 정정과 자료 추가는 가능하며 이력이 남습니다.</p>` : ''}
    <form id="af" class="card mt">
      <div class="field"><label>과제 제목 *</label><input type="text" name="title" value="${esc(a.title)}" required maxlength="200"></div>
      <div class="field"><label>과제 설명</label><textarea name="description" rows="6">${esc(a.description || '')}</textarea></div>
      <div class="field"><label>결과물 제출</label><select name="submission_required" ${L ? 'disabled' : ''}><option value="0">선택</option><option value="1" ${a.submission_required ? 'selected' : ''}>필수 (파일 또는 링크 1개 이상)</option></select></div>
      <div class="field"><label>해야 할 일 * <span class="hint">모든 할 일을 체크해야 완료됩니다.</span></label><ul class="list" id="items"></ul>
        ${L ? '' : '<button type="button" class="btn sm mt" id="add-item">+ 할 일 추가</button>'}</div>
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="row"><button class="btn primary" type="submit">저장</button><span class="small muted">버전 ${a.version}</span></div>
    </form>
    <div class="card"><h3>강사 안내 자료</h3><ul class="list" id="res"></ul>
      <div class="row mt"><form id="rlf" class="row grow"><input type="url" name="url" class="grow" placeholder="https:// 링크" required><input type="text" name="title" placeholder="표시 이름(선택)" style="max-width:200px"><button class="btn" type="submit">링크 추가</button></form>
      <label class="btn" for="rfile" style="margin:0">파일 추가</label><input type="file" id="rfile" style="position:absolute;left:-9999px"><span id="rstate" class="small muted"></span></div>
      <p class="hint">PDF·이미지·문서 등 (최대 20MB, 과제당 파일 10개·링크 10개). 기존 파일 내용은 덮어쓸 수 없으며 새 파일로 등록됩니다.</p></div>`;
  let items = a.items.map((x) => ({ ...x }));
  const drawItems = () => {
    $('#items').innerHTML = items.map((it, i) => `<li><span class="muted">${i + 1}.</span>
      <input type="text" class="grow" style="flex:1;min-width:200px" data-i="${i}" data-k="title" value="${esc(it.title)}" placeholder="할 일 제목" ${L ? 'disabled' : ''} aria-label="할 일 ${i + 1} 제목">
      <input type="text" style="flex:1;min-width:160px" data-i="${i}" data-k="description" value="${esc(it.description || '')}" placeholder="짧은 설명(선택)" ${L ? 'disabled' : ''} aria-label="할 일 ${i + 1} 설명">
      ${L ? '' : `<button type="button" class="btn sm" data-up="${i}" aria-label="위로">↑</button><button type="button" class="btn sm" data-down="${i}" aria-label="아래로">↓</button><button type="button" class="btn sm danger" data-rm="${i}" aria-label="삭제">✕</button>`}</li>`).join('') || '<li class="muted">해야 할 일을 1개 이상 추가해주세요.</li>';
    $$('#items input').forEach((inp) => inp.addEventListener('input', () => { items[inp.dataset.i][inp.dataset.k] = inp.value; }));
    $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { items.splice(+b.dataset.rm, 1); drawItems(); }));
    $$('[data-up]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.up; if (i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; drawItems(); } }));
    $$('[data-down]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.down; if (i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; drawItems(); } }));
  };
  drawItems();
  if (!L) $('#add-item').addEventListener('click', () => { items.push({ id: null, title: '', description: '' }); drawItems(); $$('#items input[data-k=title]').pop().focus(); });
  bindForm($('#af'), async (d) => {
    const body = { version: a.version, title: d.title, description: d.description };
    if (!L) { body.submission_required = d.submission_required === '1'; body.items = items; }
    try { renderAssignmentEditor(await PATCH('/api/assignments/' + a.id, body)); toast('저장되었습니다.'); } catch (e) {
      if (e.body && e.body.reason === 'VERSION_CONFLICT') {
        if (await confirmModal(e.message + '\n최신 내용을 불러올까요? (현재 입력은 사라집니다)', { okText: '최신 내용 불러오기' })) renderAssignmentEditor(e.body.latest);
        return;
      }
      throw e;
    }
  });
  const drawRes = (list) => {
    $('#res').innerHTML = list.map((r) => `<li>${r.type === 'LINK' ? `${icon('link')} <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>` : `${icon('file')} <a href="/api/files/${r.file_id}/download">${esc(r.title)}</a> <span class="small muted">${fmtSize(r.size)}</span>`}
      <span class="grow"></span><button class="btn sm" data-ren="${r.id}">이름 변경</button><button class="btn sm danger" data-rrm="${r.id}">삭제</button></li>`).join('') || '<li class="muted small">등록된 자료가 없습니다.</li>';
    $$('[data-rrm]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmModal('이 자료를 과제에서 제거할까요? (복사본 과제의 자료는 유지됩니다)', { okText: '제거', danger: true }))) return;
      try { drawRes((await DEL('/api/resources/' + b.dataset.rrm)).resources); toast('제거했습니다.'); } catch (e) { toast(errMsg(e), true); }
    }));
    $$('[data-ren]').forEach((b) => b.addEventListener('click', async () => {
      const cur = list.find((x) => x.id === b.dataset.ren);
      const m = modal(`<h2>자료 이름 변경</h2><form id="rn"><input type="text" name="title" value="${esc(cur.title)}" required><div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
      $('#rn', m.el).addEventListener('submit', async (e) => { e.preventDefault(); try { drawRes((await PATCH('/api/resources/' + cur.id, { title: e.target.title.value })).resources); m.close(); } catch (ex) { toast(errMsg(ex), true); } });
    }));
  };
  drawRes(a.resources);
  $('#rlf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { drawRes((await POST(`/api/assignments/${a.id}/resources`, { type: 'LINK', url: e.target.url.value.trim(), title: e.target.title.value })).resources); e.target.reset(); toast('링크를 추가했습니다.'); } catch (ex) { toast(errMsg(ex), true); }
  });
  $('#rfile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    $('#rstate').textContent = '업로드 중…';
    try { const f = await uploadFile(file); drawRes((await POST(`/api/assignments/${a.id}/resources`, { type: 'FILE', file_id: f.id })).resources); toast('파일을 추가했습니다.'); } catch (ex) { toast(errMsg(ex), true); }
    $('#rstate').textContent = ''; e.target.value = '';
  });
  const pub = $('#publish');
  const NOTE = '공개하면 이 강의의 모든 수강생에게 공통 과제로 적용됩니다.\n전체 수강생의 과제 수에 추가되어 진행률이 달라질 수 있습니다.';
  if (pub) pub.addEventListener('click', async () => {
    // 학생에게는 챌린지와 과제가 모두 공개여야 보인다. 챌린지가 초안이면 함께 공개할지 묻는다.
    if (a.challenge.visibility === 'DRAFT') {
      const m = modal(`<h2>과제 공개</h2><p class="pre">${esc(NOTE)}</p>
        <p class="notice warn small">소속 챌린지 '${esc(a.challenge.title)}'가 <strong>초안</strong>입니다. 챌린지도 공개해야 수강생에게 보입니다.</p>
        <div class="actions"><button class="btn" data-close>취소</button><button class="btn" id="only">과제만 공개 (나중에 챌린지 공개)</button><button class="btn primary" id="both">챌린지와 함께 공개</button></div>`);
      const go = async (withChallenge) => {
        m.close();
        try { renderAssignmentEditor(await POST(`/api/assignments/${a.id}/publish`, { publish_challenge: withChallenge })); toast(withChallenge ? '챌린지와 과제를 공개했습니다.' : '과제를 공개했습니다. 챌린지를 공개하면 수강생에게 보입니다.'); } catch (e) { toast(errMsg(e), true); }
      };
      $('#only', m.el).addEventListener('click', () => go(false));
      $('#both', m.el).addEventListener('click', () => go(true));
      return;
    }
    if (!(await confirmModal(NOTE, { okText: '공개' }))) return;
    try { renderAssignmentEditor(await POST(`/api/assignments/${a.id}/publish`)); toast('공개했습니다.'); } catch (e) { toast(errMsg(e), true); }
  });
  const pubCh = $('#pub-ch');
  if (pubCh) pubCh.addEventListener('click', async () => {
    if (!(await confirmModal(`'${a.challenge.title}' 챌린지를 공개합니다.\n이 챌린지의 공개 과제가 모든 수강생에게 보이고 진행률에 반영됩니다.`, { okText: '챌린지 공개' }))) return;
    try { renderAssignmentEditor(await POST(`/api/assignments/${a.id}/publish`, { publish_challenge: true })); toast('챌린지를 공개했습니다.'); } catch (e) { toast(errMsg(e), true); }
  });
  const unp = $('#unpublish');
  if (unp) unp.addEventListener('click', async () => { try { renderAssignmentEditor(await POST(`/api/assignments/${a.id}/unpublish`)); toast('초안으로 전환했습니다.'); } catch (e) { toast(errMsg(e), true); } });
  const del = $('#delete');
  if (del) del.addEventListener('click', async () => {
    if (!(await confirmModal('이 과제를 삭제할까요?', { okText: '삭제', danger: true }))) return;
    try { await DEL('/api/assignments/' + a.id); toast('삭제했습니다.'); location.hash = `#/a/c/${a.course.id}/challenges`; } catch (e) { toast(errMsg(e), true); }
  });
  $('#copy').addEventListener('click', async () => {
    const t = await GET('/api/copy-targets');
    const m = modal(`<h2>과제 복사</h2><form id="cpf"><div class="field"><label>대상 챌린지</label><select name="target" required>${t.items.map((c) => `<optgroup label="${esc(c.code)} ${esc(c.title)} ${esc(c.cohort_label)}">${c.challenges.map((ch) => `<option value="${ch.id}" ${ch.id === a.challenge.id ? 'selected' : ''}>${esc(ch.title)} (${esc(ch.start_date)}~${esc(ch.end_date)})</option>`).join('')}</optgroup>`).join('')}</select></div>
      <div class="field"><label>새 과제 제목</label><input type="text" name="title" value="${esc(a.title)} (복사)"></div>
      <p class="small muted">새 초안·미동결 과제로 만들어지며 학생 기록·피드백은 복사되지 않습니다.</p><p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">복사</button></div></form>`);
    const key = uid();
    bindForm($('#cpf', m.el), async (d) => {
      const n = await POST(`/api/assignments/${a.id}/copy`, { target_challenge_id: d.target, title: d.title, idempotency_key: key });
      m.close(); toast('복사했습니다.'); location.hash = '#/a/as/' + n.id;
    });
  });
  $('#preview').addEventListener('click', () => {
    modal(`<h2>학생 화면 미리보기</h2><p class="small muted">${esc(a.challenge.title)} · ${esc(a.challenge.start_date)} ~ ${esc(a.challenge.end_date)}</p>
      <h3>${esc(a.title)}</h3>${a.description ? `<div class="pre card">${esc(a.description)}</div>` : ''}
      ${a.resources.length ? `<div class="card"><strong>강사 자료</strong><ul class="list">${a.resources.map((r) => `<li>${icon(r.type === 'LINK' ? 'link' : 'file')} ${esc(r.title)}</li>`).join('')}</ul></div>` : ''}
      <div class="card"><strong>해야 할 일 (0/${a.items.length})</strong><ul class="checklist mt">${a.items.map((it) => `<li><input type="checkbox" disabled><label>${esc(it.title)}${it.description ? `<div class="hint">${esc(it.description)}</div>` : ''}</label></li>`).join('')}</ul></div>
      <div class="card"><strong>결과물 제출</strong> ${a.submission_required ? '<span class="badge warn">필수</span>' : '<span class="badge">선택</span>'}</div>
      <p class="small muted">저장된 내용 기준입니다.</p><div class="actions"><button class="btn" data-close>닫기</button></div>`, { wide: true });
  });
}

/* 진행 현황 매트릭스 */
async function courseProgress(el, c, q) {
  const page = Number(q.page) || 1; const size = Number(q.size) || 50;
  const [chs, d] = await Promise.all([GET(`/api/courses/${c.id}/challenges`), GET(`/api/courses/${c.id}/progress` + qs({ challenge_id: q.challenge_id, status: q.status, q: q.q, filter: q.filter, page, size }))]);
  const go = (p) => { location.hash = `#/a/c/${c.id}/progress` + qs({ ...q, ...p }); };
  const F = { '': '전체', NOT_STARTED: '미시작(전체 과제)', HAS_NOT_STARTED: '미시작 과제 있음', NEED_SUBMISSION: '제출 필요 있음', INCOMPLETE: '미완료 있음', COMPLETED: '모두 완료', LATE: '기한 후 완료 있음', UNREAD_FEEDBACK: '피드백 미확인' };
  el.innerHTML = `<form class="filters" id="flt">
      <select name="challenge_id"><option value="">전체 챌린지</option>${chs.items.map((x) => `<option value="${x.id}" ${q.challenge_id === x.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>
      <select name="filter">${Object.entries(F).map(([k, v]) => `<option value="${k}" ${(q.filter || '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select name="status"><option value="ACTIVE">활성 등록</option><option value="INACTIVE" ${q.status === 'INACTIVE' ? 'selected' : ''}>비활성 이력</option><option value="ALL" ${q.status === 'ALL' ? 'selected' : ''}>전체</option></select>
      <input type="search" name="q" placeholder="이름·학생번호·전화번호" value="${esc(q.q || '')}"><button class="btn" type="submit">조회</button></form>
    <div class="card mb"><strong>${d.summary.assignments ? (d.summary.students ? `완료 ${d.summary.completed} / 대상 ${d.summary.target} 건 · ${pctText(d.summary.rate)}` : '수강생 없음') : '과제 없음'}</strong>
      <span class="small muted"> (활성 수강생 ${d.summary.students}명 × 공개 과제 ${d.summary.assignments}개, 필터 적용 기준)</span>
      <div class="small mt">${Object.keys(STATUS).map((k) => statusBadge(k)).join(' ')}</div></div>
    <div class="table-wrap"><table class="matrix"><thead><tr><th>학생</th><th class="num">완료</th>${d.assignments.map((a) => `<th class="as" title="${esc(a.challenge_title)}">${esc(a.title)}${a.submission_required ? ' *' : ''}</th>`).join('')}<th>피드백</th></tr></thead>
    <tbody>${d.rows.map((r) => `<tr class="click" data-href="#/a/e/${r.enrollment_id}"><td><strong>${esc(r.student.name)}</strong><div class="small muted">${esc(r.student.code)} · ${esc(r.student.phone)}${r.enrollment_status !== 'ACTIVE' ? ' · <span class="badge danger">비활성</span>' : ''}</div></td>
      <td class="num">${r.total ? `${r.completed}/${r.total}<div class="small muted">${pctText(r.rate)}</div>` : '—'}</td>
      ${r.cells.map((x) => `<td class="cell">${statusBadge(x.status, false)}<div class="small muted">${x.checked}/${x.items}${x.subs ? ` · ${icon('file', '제출물')}${x.subs}` : ''}</div></td>`).join('')}
      <td>${r.unread_feedback ? `<span class="badge warn">미확인 ${r.unread_feedback}</span>` : ''}</td></tr>`).join('') || `<tr><td colspan="${d.assignments.length + 3}" class="center muted">표시할 학생이 없습니다.</td></tr>`}</tbody></table></div>
    <p class="small muted">* 제출 필수 과제. 셀 숫자는 체크한 할 일/전체, 파일 아이콘 옆 숫자는 현재 제출물 수입니다.</p>`;
  el.appendChild(pagination(d.total, d.page, d.size, (p, s) => go({ page: p, size: s })));
  $('#flt').addEventListener('submit', (e) => { e.preventDefault(); go({ ...formData(e.target), page: 1 }); });
  $$('tr[data-href]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}

/* 학생 상세 (강의 범위) + 피드백 */
route('/a/e/:id', async ({ id }) => {
  const d = await GET(`/api/enrollments/${id}/detail`);
  APP().innerHTML = `<div class="breadcrumb"><a href="#/a/c/${d.course.id}/students">${esc(d.course.title)} ${esc(d.course.cohort_label)}</a> › 학생 상세</div>
    <div class="grid two">
      <div class="card"><div class="row between"><h2>${esc(d.student.name)} <span class="small muted">${esc(d.student.code)}</span></h2>
        ${d.enrollment.status === 'ACTIVE' ? '<span class="badge ok">활성 등록</span>' : '<span class="badge danger">비활성 등록</span>'}</div>
        <dl class="kv"><dt>로그인 아이디</dt><dd>${esc(d.student.name)}</dd><dt>전화번호</dt><dd id="phone">${esc(d.student.phone)}</dd>
        <dt>등록일</dt><dd>${fmtDT(d.enrollment.enrolled_at)}</dd>${d.enrollment.deactivated_at ? `<dt>비활성화</dt><dd>${fmtDT(d.enrollment.deactivated_at)} ${esc(d.enrollment.reason || '')}</dd>` : ''}
        ${ME.isAdmin ? `<dt>등록 메모</dt><dd class="pre">${esc(d.enrollment.admin_memo || '-')}</dd>` : ''}</dl>
        <div class="row mt">${d.can_reveal_login ? '<button class="btn" id="reveal">로그인 정보 확인</button>' : '<span class="small muted">비활성 수강생의 로그인 정보는 확인할 수 없습니다.</span>'}
        ${ME.isAdmin ? `<a class="btn" href="#/a/st/${d.student.id}">전체 학생 정보</a>` : ''}<button class="btn" id="edit-st">정보 수정</button>
        <button class="btn ${d.enrollment.status === 'ACTIVE' ? 'danger' : ''}" id="toggle">${d.enrollment.status === 'ACTIVE' ? '등록 비활성화' : '재활성화'}</button><button class="btn danger" id="del-en">등록 삭제</button></div>
        <p class="small muted" id="reveal-box"></p></div>
      <div class="card"><h2>${ME.isAdmin ? '다른 수강 이력' : '내가 담당하는 다른 강의 수강 이력'}</h2><ul class="list">${d.other_enrollments.map((o) => `<li><a href="#/a/e/${o.id}">${esc(o.code)} ${esc(o.title)} ${esc(o.cohort_label)}</a> ${o.status === 'ACTIVE' ? '' : '<span class="badge danger">비활성</span>'}</li>`).join('') || '<li class="muted small">없음</li>'}</ul></div>
    </div>
    <h2 class="mt">과제별 수행</h2>
    ${d.tasks.map((t) => `<div class="card" id="t-${t.id}">
      <div class="row between"><div><strong>${esc(t.title)}</strong> <span class="small muted">${esc(t.challenge_title)} · 제출 ${t.submission_required ? '필수' : '선택'}</span></div>${statusBadge(t.status)}</div>
      <div class="small muted">할 일 ${t.checked}/${t.item_count}${t.completed_at ? ` · 완료 ${fmtDT(t.completed_at)}${t.completion_timing === 'LATE' ? ' (기한 후)' : ''}` : ''}${t.started_at ? ` · 시작 ${fmtDT(t.started_at)}` : ''}</div>
      <div class="grid two mt">
        <div><strong class="small">해야 할 일</strong><ul class="list small">${t.items.map((i) => `<li>${icon(i.is_checked ? 'checkbox' : 'box', i.is_checked ? '완료' : '미완료')} ${esc(i.title)}${i.checked_at ? ` <span class="muted">${fmtDT(i.checked_at)}</span>` : ''}</li>`).join('')}</ul></div>
        <div><strong class="small">제출물 (현재·이전 버전)</strong><ul class="list small">${t.submissions.map((s) => `<li style="display:block">${s.status === 'REMOVED' ? `<span class="badge">삭제됨 ${fmtDT(s.removed_at)}</span> ` : ''}
          ${s.versions.map((v) => `<div>${v.revision === s.current_revision && s.status === 'READY' ? '<span class="badge ok">현재</span>' : `<span class="badge">v${v.revision}</span>`}
            ${v.type === 'LINK' ? `<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer" style="word-break:break-all">${esc(v.url)}</a>` : `<a href="/api/files/${v.file_id}/download">${esc(v.original_name)}</a> ${fmtSize(v.size)}`}
            <span class="muted">${fmtDT(v.created_at)}</span></div>`).join('')}</li>`).join('') || '<li class="muted">없음</li>'}</ul></div>
      </div>
      <div class="mt"><strong class="small">피드백</strong>
        ${t.feedback.map((f) => `<div class="feedback ${f.deleted_at ? 'deleted' : ''} mt"><div class="row between small"><strong>${esc(f.author_name)}</strong>
          <span class="muted">${fmtDT(f.created_at)}${f.version > 1 ? ` · 수정 ${fmtDT(f.updated_at)}` : ''} · ${f.deleted_at ? '삭제됨' : f.read ? '학생 확인함' : '<span class="badge warn">미확인</span>'}</span></div>
          ${f.deleted_at ? '' : `<div class="pre mt">${esc(f.body)}</div>`}
          ${f.submission_refs.length ? `<div class="small muted">피드백 당시 제출 버전: ${f.submission_refs.map((r) => `v${r.submission_revision}`).join(', ')}</div>` : ''}
          ${!f.deleted_at && (ME.isAdmin || f.author_staff_id === ME.id) ? `<div class="row mt"><button class="btn sm" data-fe="${f.id}" data-v="${f.version}">수정</button><button class="btn sm danger" data-fd="${f.id}">삭제</button>${f.history_count > 1 ? `<button class="btn sm" data-fh="${f.id}">이력</button>` : ''}</div>` : (f.history_count > 1 ? `<button class="btn sm mt" data-fh="${f.id}">이력</button>` : '')}
        </div>`).join('') || '<p class="small muted">아직 피드백이 없습니다.</p>'}
        <form class="mt" data-ff="${t.id}"><textarea name="body" placeholder="${esc(d.student.name)}님에게 남길 피드백" required maxlength="10000"></textarea><button class="btn primary mt" type="submit">피드백 남기기</button></form>
      </div></div>`).join('') || '<div class="card muted center">공개된 과제가 없습니다.</div>'}`;
  const rv = $('#reveal');
  if (rv) rv.addEventListener('click', async () => {
    try { const r = await POST(`/api/enrollments/${id}/login-info/reveal`); $('#phone').innerHTML = `<strong>${esc(r.phone_display)}</strong>`; $('#reveal-box').textContent = `로그인 아이디: ${r.login_id} / 비밀번호: ${r.login_password} — 조회 이력이 기록되었습니다.`; } catch (e) { toast(errMsg(e), true); }
  });
  const enr = { id, status: d.enrollment.status, student: d.student };
  $('#toggle').addEventListener('click', () => toggleEnrollment(id, d.enrollment.status));
  $('#edit-st').addEventListener('click', () => editEnrollmentStudent(enr));
  // 삭제되면 이 화면은 더 이상 없으므로 수강생 목록으로 이동
  $('#del-en').addEventListener('click', () => deleteEnrollment(enr, () => { location.hash = `#/a/c/${d.course.id}/students`; }));
  $$('form[data-ff]').forEach((f) => bindForm(f, async (v) => { await POST(`/api/enrollments/${id}/assignments/${f.dataset.ff}/feedback`, { body: v.body }); toast('피드백을 남겼습니다.'); rerender(); }));
  $$('[data-fd]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('피드백을 삭제할까요? 삭제 이력은 보존됩니다.', { okText: '삭제', danger: true }))) return;
    try { await DEL('/api/feedback/' + b.dataset.fd); toast('삭제했습니다.'); rerender(); } catch (e) { toast(errMsg(e), true); }
  }));
  $$('[data-fe]').forEach((b) => b.addEventListener('click', () => {
    const f = d.tasks.flatMap((t) => t.feedback).find((x) => x.id === b.dataset.fe);
    const m = modal(`<h2>피드백 수정</h2><form id="fef"><textarea name="body" rows="6" required>${esc(f.body)}</textarea><p class="small muted">수정하면 학생에게 다시 새 피드백으로 표시됩니다.</p><p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
    bindForm($('#fef', m.el), async (v) => { await PATCH('/api/feedback/' + f.id, { body: v.body, version: f.version }); m.close(); toast('수정했습니다.'); rerender(); });
  }));
  $$('[data-fh]').forEach((b) => b.addEventListener('click', async () => {
    const h = await GET(`/api/feedback/${b.dataset.fh}/history`);
    modal(`<h2>피드백 이력</h2>${h.items.map((x) => `<div class="feedback"><div class="small muted">v${x.version} · ${({ CREATED: '작성', UPDATED: '수정', DELETED: '삭제' })[x.action]} · ${esc(x.actor_name)} · ${fmtDT(x.created_at)}</div>${x.body ? `<div class="pre">${esc(x.body)}</div>` : ''}</div>`).join('')}<div class="actions"><button class="btn" data-close>닫기</button></div>`);
  }));
}, { auth: 'STAFF' });

/* 강사 관리 (관리자) */
route('/a/staff', async (_p, q) => {
  const { items } = await GET('/api/staff' + qs({ q: q.q }));
  const ST = { ACTIVE: ['활성', 'ok'], PENDING: ['설정 대기', 'warn'], DISABLED: ['비활성', 'danger'] };
  APP().innerHTML = `<div class="row between mb"><h1>강사·운영자 관리</h1><button class="btn primary" id="new">+ 계정 발급</button></div>
    <form class="filters" id="flt"><input type="search" name="q" placeholder="이름·이메일" value="${esc(q.q || '')}"><button class="btn" type="submit">검색</button></form>
    <div class="table-wrap"><table><thead><tr><th>강사 번호</th><th>이름</th><th>이메일</th><th>역할</th><th>계정 상태</th><th>배정 강의</th><th>최근 로그인</th><th></th></tr></thead>
    <tbody>${items.map((s) => `<tr><td>${esc(s.instructor_code || '-')}</td><td>${esc(s.name)}</td><td>${esc(s.email)}</td>
      <td>${s.roles.map((r) => `<span class="badge">${r === 'ADMIN' ? '관리자' : '강사'}</span>`).join(' ')}</td>
      <td><span class="badge ${ST[s.status][1]}">${ST[s.status][0]}</span></td>
      <td class="small">${s.courses.map((c) => `<a href="#/a/c/${c.id}/overview">${esc(c.code)} ${esc(c.title)} ${esc(c.cohort_label)}</a>`).join('<br>') || '-'}</td>
      <td class="small">${fmtDT(s.last_login_at) || '-'}</td>
      <td class="num"><button class="btn sm" data-edit="${s.id}">수정</button> <button class="btn sm" data-link="${s.id}">${s.has_password ? '재설정 링크' : '설정 링크'}</button></td></tr>`).join('') || '<tr><td colspan="8" class="center muted">계정이 없습니다.</td></tr>'}</tbody></table></div>`;
  $('#flt').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/a/staff' + qs(formData(e.target)); });
  const showLink = (r, after) => {
    const url = location.origin + r.setup_path;
    const m = modal(`<h2>계정 설정 링크</h2><p class="small">아래 링크를 강사에게 전달해주세요. ${fmtDT(r.expires_at)}까지 유효한 1회용 링크이며, 다시 발급하면 이전 링크는 무효가 됩니다.</p>
      <div class="copybox"><input type="text" readonly value="${esc(url)}" id="lk"><button class="btn" id="cp">복사</button></div><div class="actions"><button class="btn" data-close>닫기</button></div>`);
    $('#cp', m.el).addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); toast('복사했습니다.'); } catch { $('#lk', m.el).select(); } });
    if (after) $$('[data-close]', m.el).forEach((b) => b.addEventListener('click', after));
  };
  $('#new').addEventListener('click', () => {
    const m = modal(`<h2>계정 발급</h2><form id="sf">
      <div class="field"><label>이름 *</label><input type="text" name="name" required maxlength="50"></div>
      <div class="field"><label>이메일 (로그인 아이디) *</label><input type="email" name="email" required></div>
      <div class="field"><label>역할 *</label><label class="inline"><input type="checkbox" name="r" value="INSTRUCTOR" checked> 강사</label> <label class="inline"><input type="checkbox" name="r" value="ADMIN"> 관리자</label></div>
      <div class="field"><label>연락처 (선택)</label><input type="tel" name="phone"></div>
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">발급</button></div></form>`);
    bindForm($('#sf', m.el), async (d, form) => {
      const r = await POST('/api/staff', { name: d.name, email: d.email, phone: d.phone || undefined, roles: $$('input[name=r]:checked', form).map((x) => x.value) });
      m.close(); showLink(r, rerender);
    });
  });
  $$('[data-link]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('새 설정 링크를 발급하면 이전 미사용 링크는 무효가 됩니다.', { okText: '발급' }))) return;
    try { showLink(await POST(`/api/staff/${b.dataset.link}/setup-link`)); } catch (e) { toast(errMsg(e), true); }
  }));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const s = items.find((x) => x.id === b.dataset.edit);
    const m = modal(`<h2>계정 수정</h2><p class="small muted">${esc(s.email)}</p><form id="ef">
      <div class="field"><label>이름</label><input type="text" name="name" value="${esc(s.name)}" required></div>
      <div class="field"><label>역할</label><label class="inline"><input type="checkbox" name="r" value="INSTRUCTOR" ${s.roles.includes('INSTRUCTOR') ? 'checked' : ''}> 강사</label> <label class="inline"><input type="checkbox" name="r" value="ADMIN" ${s.roles.includes('ADMIN') ? 'checked' : ''}> 관리자</label></div>
      <div class="field"><label>계정 상태</label><select name="status"><option value="ACTIVE" ${s.status !== 'DISABLED' ? 'selected' : ''}>사용</option><option value="DISABLED" ${s.status === 'DISABLED' ? 'selected' : ''}>비활성 (모든 접근·세션 중단)</option></select></div>
      <p class="form-error small" style="color:var(--danger)"></p>
      <div class="actions"><button type="button" class="btn" data-close>취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
    bindForm($('#ef', m.el), async (d, form) => { await PATCH('/api/staff/' + s.id, { name: d.name, status: d.status, roles: $$('input[name=r]:checked', form).map((x) => x.value) }); m.close(); toast('저장되었습니다.'); rerender(); });
  }));
}, { auth: 'ADMIN' });

/* 전체 학생 관리 (관리자) */
route('/a/students', async (_p, q) => {
  const page = Number(q.page) || 1; const size = Number(q.size) || 50;
  const d = await GET('/api/students' + qs({ q: q.q, page, size }));
  APP().innerHTML = `<h1>전체 학생 관리</h1><p class="small muted">전화번호 기준으로 학생 고유번호가 하나씩 부여됩니다. 강의 등록은 각 강의의 수강생 탭에서 진행합니다.</p>
    <form class="filters" id="flt"><input type="search" name="q" placeholder="이름·학생번호·전화번호" value="${esc(q.q || '')}"><button class="btn" type="submit">검색</button></form>
    <div class="table-wrap"><table><thead><tr><th>학생 번호</th><th>이름</th><th>전화번호</th><th>상태</th><th class="num">활성/전체 수강</th><th>등록일</th></tr></thead>
    <tbody>${d.items.map((s) => `<tr class="click" data-href="#/a/st/${s.id}"><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3'))}</td>
      <td>${s.status === 'ACTIVE' ? '<span class="badge ok">활성</span>' : '<span class="badge danger">비활성</span>'}</td><td class="num">${s.active_enrollments}/${s.total_enrollments}</td><td class="small">${fmtDT(s.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="center muted">학생이 없습니다.</td></tr>'}</tbody></table></div>`;
  APP().appendChild(pagination(d.total, d.page, d.size, (p, s) => { location.hash = '#/a/students' + qs({ ...q, page: p, size: s }); }));
  $('#flt').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/a/students' + qs(formData(e.target)); });
  $$('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}, { auth: 'ADMIN' });

route('/a/st/:id', async ({ id }) => {
  const s = await GET('/api/students/' + id);
  APP().innerHTML = `<div class="breadcrumb"><a href="#/a/students">전체 학생</a> ›</div>
    <h1>${esc(s.name)} <span class="small muted">${esc(s.code)}</span> ${s.status === 'ACTIVE' ? '<span class="badge ok">활성</span>' : '<span class="badge danger">비활성</span>'}</h1>
    <div class="grid two">
      <div class="card"><h2>정보 정정</h2><p class="small muted">이름·전화번호 정정은 같은 학생 ID를 유지하며 모든 수강 강의에 반영됩니다. 로그인 정보가 바뀌면 기존 세션이 취소됩니다.</p>
        <form id="cf"><div class="field"><label>이름 (로그인 아이디)</label><input type="text" name="name" value="${esc(s.name)}" required></div>
        <div class="field"><label>전화번호 (로그인 비밀번호)</label><input type="tel" name="phone" value="${esc(s.phone)}" required></div>
        <div class="field"><label>학생 계정 상태</label><select name="status"><option value="ACTIVE">활성</option><option value="DISABLED" ${s.status === 'DISABLED' ? 'selected' : ''}>비활성 (모든 강의 접근 중단)</option></select></div>
        <div class="field"><label>변경 사유 *</label><input type="text" name="reason" maxlength="500" placeholder="예: 명단 입력 오류 정정"></div>
        <p class="form-error small" style="color:var(--danger)"></p><button class="btn primary" type="submit">저장</button></form></div>
      <div class="card"><h2>수강 이력</h2><ul class="list">${s.enrollments.map((e) => `<li><a class="grow" href="#/a/e/${e.id}">${esc(e.course_code)} ${esc(e.title)} ${esc(e.cohort_label)}</a>
        ${e.status === 'ACTIVE' ? '<span class="badge ok">활성</span>' : `<span class="badge danger">비활성</span> <span class="small muted">${esc(e.reason || '')}</span>`}</li>`).join('') || '<li class="muted">없음</li>'}</ul></div>
    </div>`;
  bindForm($('#cf'), async (d) => {
    const pre = await PATCH('/api/students/' + id, { ...d, dry_run: true });
    if (pre.login_changed && !(await confirmModal(`로그인 정보(이름·전화번호)가 변경됩니다. 영향받는 강의 ${pre.affected_courses}개에 모두 반영되며 기존 세션이 취소됩니다.`, { okText: '저장' }))) return;
    await PATCH('/api/students/' + id, d); toast('저장되었습니다.'); rerender();
  });
}, { auth: 'ADMIN' });

/* 변경 이력 */
async function auditList(el, base, q, hashBase) {
  const page = Number(q.page) || 1; const size = Number(q.size) || 50;
  const d = await GET('/api/audit-logs' + qs({ ...base, target_type: q.target_type, action: q.action, page, size }));
  const T = { COURSE: '강의', STAFF: '운영자', STUDENT: '학생', ENROLLMENT: '수강 등록', CHALLENGE: '챌린지', ASSIGNMENT: '과제', RESOURCE: '자료', FEEDBACK: '피드백', IMPORT: '명단 업로드' };
  el.innerHTML = `<form class="filters" id="flt"><select name="target_type"><option value="">대상 전체</option>${Object.entries(T).map(([k, v]) => `<option value="${k}" ${q.target_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <input type="search" name="action" placeholder="동작 (예: LOCK, PUBLISHED)" value="${esc(q.action || '')}"><button class="btn" type="submit">검색</button></form>
    <div class="table-wrap"><table><thead><tr><th>시각</th><th>처리자</th><th>강의</th><th>대상</th><th>동작</th><th>변경 내용·사유</th></tr></thead>
    <tbody>${d.items.map((l) => `<tr><td class="small">${fmtDT(l.created_at)}</td><td class="small">${esc(l.actor_name || l.actor_type)}</td><td class="small">${l.course_code ? `${esc(l.course_code)} ${esc(l.course_title)} ${esc(l.cohort_label)}` : '-'}</td>
      <td class="small">${T[l.target_type] || esc(l.target_type)}</td><td class="small">${esc(l.action)}</td>
      <td class="small"><code style="white-space:pre-wrap;word-break:break-all">${esc(l.changed_fields ? JSON.stringify(l.changed_fields) : '')}</code>${l.reason ? `<div>사유: ${esc(l.reason)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="center muted">이력이 없습니다.</td></tr>'}</tbody></table></div>`;
  el.appendChild(pagination(d.total, d.page, d.size, (p, s) => { location.hash = hashBase + qs({ ...q, page: p, size: s }); }));
  $('#flt', el).addEventListener('submit', (e) => { e.preventDefault(); location.hash = hashBase + qs(formData(e.target)); });
}
route('/a/logs', async (_p, q) => {
  APP().innerHTML = '<h1>변경 이력</h1><div id="logs"></div>';
  await auditList($('#logs'), {}, q, '#/a/logs');
}, { auth: 'ADMIN' });

/* 내 계정 */
route('/a/account', async () => {
  APP().innerHTML = `<h1>내 계정</h1><div class="grid two"><div class="card"><dl class="kv"><dt>이름</dt><dd>${esc(ME.name)}</dd><dt>이메일</dt><dd>${esc(ME.email)}</dd>
    <dt>역할</dt><dd>${ME.roles.map((r) => (r === 'ADMIN' ? '관리자' : '강사')).join(', ')}</dd>${ME.instructorCode ? `<dt>강사 번호</dt><dd>${esc(ME.instructorCode)}</dd>` : ''}</dl></div>
    <div class="card"><h2>비밀번호 변경</h2><form id="pf">
      <div class="field"><label>현재 비밀번호</label><input type="password" name="current_password" autocomplete="current-password" required></div>
      <div class="field"><label>새 비밀번호 (8자 이상)</label><input type="password" name="new_password" autocomplete="new-password" minlength="8" required></div>
      <div class="field"><label>새 비밀번호 확인</label><input type="password" name="confirm" autocomplete="new-password" required></div>
      <p class="form-error small" style="color:var(--danger)"></p><button class="btn primary" type="submit">변경</button></form>
      <p class="small muted">변경하면 모든 기기에서 로그아웃되며 새 비밀번호로 다시 로그인해야 합니다.</p></div></div>`;
  bindForm($('#pf'), async (d) => {
    if (d.new_password !== d.confirm) throw new Error('새 비밀번호 확인이 일치하지 않습니다.');
    await POST('/api/auth/staff/password', d);
    ME = null; CSRF = ''; toast('비밀번호를 변경했습니다. 다시 로그인해주세요.'); location.hash = '#/staff-login';
  });
}, { auth: 'STAFF' });

/* ===== 시작 ===== */
window.addEventListener('hashchange', router);
(async () => {
  try { await loadMe(); } catch (_) { ME = null; }
  router();
})();
