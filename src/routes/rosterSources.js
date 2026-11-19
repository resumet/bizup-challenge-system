'use strict';
// 외부 명단 API 연동 소스 관리 (관리자 전용)
const express = require('express');
const { get, all, run, uuid, now } = require('../db');
const U = require('../util');
const { E } = U;
const A = require('../auth');
const F = require('../files');
const { fetchRoster } = require('../rosterApi');

const r = express.Router();
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const PATH = /^[A-Za-z0-9_$\-.]{0,200}$/;

// 인증 헤더 값은 다시 내려보내지 않는다(이름과 마스킹만)
function view(s) {
  const headers = JSON.parse(s.headers || '{}');
  return {
    id: s.id, name: s.name, url: s.url, method: s.method, body_template: s.body_template, items_path: s.items_path,
    name_field: s.name_field, phone_field: s.phone_field, memo_field: s.memo_field, status: s.status,
    header_names: Object.keys(headers), created_at: s.created_at, updated_at: s.updated_at, last_used_at: s.last_used_at,
  };
}

// headers 입력: [{ name, value }] — value가 비어 있으면 기존 값을 유지, remove=true면 삭제
function mergeHeaders(existing, input) {
  if (!Array.isArray(input)) return existing;
  const out = {};
  for (const h of input.slice(0, 20)) {
    const name = String(h && h.name || '').trim();
    if (!name || h.remove) continue;
    if (!HEADER_NAME.test(name)) throw E.invalid(`헤더 이름이 올바르지 않습니다: ${name.slice(0, 50)}`);
    if (/^(host|content-length|connection|transfer-encoding|cookie)$/i.test(name)) throw E.invalid(`${name} 헤더는 지정할 수 없습니다.`);
    const value = h.value !== undefined && h.value !== null && String(h.value) !== '' ? String(h.value) : existing[name];
    if (value === undefined) throw E.invalid(`${name} 헤더 값을 입력해주세요.`);
    if (/[\r\n]/.test(value) || value.length > 4000) throw E.invalid(`${name} 헤더 값이 올바르지 않습니다.`);
    out[name] = value;
  }
  return out;
}

function input(body, existing = {}) {
  const pickStr = (k, label, max, required) => {
    const v = body[k] !== undefined ? (U.str(body[k], max) || '').trim() : (existing[k] || '');
    if (required && !v) throw E.invalid(`${label}을(를) 입력해주세요.`);
    return v || null;
  };
  const o = {
    name: pickStr('name', '이름', 100, true),
    url: pickStr('url', 'API 주소', 2000, true),
    method: body.method !== undefined ? String(body.method).toUpperCase() : existing.method || 'GET',
    body_template: pickStr('body_template', '요청 본문', 10000),
    items_path: pickStr('items_path', '목록 위치', 200),
    name_field: pickStr('name_field', '이름 필드', 200, true),
    phone_field: pickStr('phone_field', '전화번호 필드', 200, true),
    memo_field: pickStr('memo_field', '메모 필드', 200),
    status: body.status !== undefined ? body.status : existing.status || 'ACTIVE',
  };
  if (!['GET', 'POST'].includes(o.method)) throw E.invalid('요청 방식은 GET 또는 POST만 지원합니다.');
  if (!['ACTIVE', 'DISABLED'].includes(o.status)) throw E.invalid('상태 값이 올바르지 않습니다.');
  for (const k of ['items_path', 'name_field', 'phone_field', 'memo_field']) if (o[k] && !PATH.test(o[k])) throw E.invalid('필드·목록 위치는 영문·숫자·밑줄과 점(.)으로 입력해주세요. 예: data.students');
  if (o.method === 'POST' && o.body_template) {
    try { JSON.parse(o.body_template.replace(/\{(course_code|course_title|cohort_label|param)\}/g, 'x')); } catch (_) { throw E.invalid('요청 본문은 JSON 형식이어야 합니다.'); }
  }
  // 자리표시자를 채운 형태로 주소 형식만 미리 확인 (실제 접속 가능 여부는 연결 테스트에서)
  const probe = o.url.replace(/\{(course_code|course_title|cohort_label|param)\}/g, 'x');
  const u = (() => { try { return new URL(probe); } catch (_) { throw E.invalid('API 주소 형식이 올바르지 않습니다.'); } })();
  if (u.protocol !== 'https:' && process.env.ROSTER_API_ALLOW_PRIVATE !== '1') throw E.invalid('API 주소는 https:// 로 시작해야 합니다.');
  o.headers = JSON.stringify(mergeHeaders(JSON.parse(existing.headers || '{}'), body.headers));
  return o;
}

r.get('/roster-sources', A.requireAdmin, async (req, res) => {
  res.json({ items: (await all('SELECT * FROM roster_sources ORDER BY created_at DESC')).map(view) });
});
r.post('/roster-sources', A.requireAdmin, async (req, res) => {
  const o = input(req.body);
  const id = uuid(); const t = now();
  await run(`INSERT INTO roster_sources(id, name, url, method, headers, body_template, items_path, name_field, phone_field, memo_field, status, created_by, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, o.name, o.url, o.method, o.headers, o.body_template, o.items_path, o.name_field, o.phone_field, o.memo_field, o.status, req.user.id, t, t);
  await A.audit(req, { targetType: 'ROSTER_SOURCE', targetId: id, action: 'ROSTER_SOURCE_CREATED', changed: { name: o.name, url: o.url } });
  res.status(201).json(view(await get('SELECT * FROM roster_sources WHERE id = ?', id)));
});
r.patch('/roster-sources/:id', A.requireAdmin, async (req, res) => {
  const s = await get('SELECT * FROM roster_sources WHERE id = ?', req.params.id);
  if (!s) throw E.notFound();
  const o = input(req.body, s);
  await run(`UPDATE roster_sources SET name=?, url=?, method=?, headers=?, body_template=?, items_path=?, name_field=?, phone_field=?, memo_field=?, status=?, updated_at=? WHERE id=?`,
    o.name, o.url, o.method, o.headers, o.body_template, o.items_path, o.name_field, o.phone_field, o.memo_field, o.status, now(), s.id);
  await A.audit(req, { targetType: 'ROSTER_SOURCE', targetId: s.id, action: 'ROSTER_SOURCE_UPDATED', changed: { name: o.name, url: o.url, status: o.status } });
  res.json(view(await get('SELECT * FROM roster_sources WHERE id = ?', s.id)));
});
r.delete('/roster-sources/:id', A.requireAdmin, async (req, res) => {
  const s = await get('SELECT * FROM roster_sources WHERE id = ?', req.params.id);
  if (!s) throw E.notFound();
  await run('DELETE FROM roster_sources WHERE id = ?', s.id);
  await A.audit(req, { targetType: 'ROSTER_SOURCE', targetId: s.id, action: 'ROSTER_SOURCE_DELETED', changed: { name: s.name } });
  res.json({ ok: true });
});

// 연결 테스트: 실제로 요청해 건수·응답 필드·처음 몇 행(매핑 결과)을 보여준다. DB에는 아무것도 만들지 않는다.
r.post('/roster-sources/:id/test', A.requireAdmin, async (req, res) => {
  const s = await get('SELECT * FROM roster_sources WHERE id = ?', req.params.id);
  if (!s) throw E.notFound();
  const course = req.body.course_id ? await get('SELECT * FROM courses WHERE id = ?', String(req.body.course_id)) : null;
  const vars = { course_code: course ? course.code : '', course_title: course ? course.title : '', cohort_label: course ? course.cohort_label : '', param: U.str(req.body.param, 200) || '' };
  const d = await fetchRoster(s, vars, { maxRows: F.LIMITS.rosterRows });
  const valid = d.items.filter((x) => U.normalizeName(x.name) && U.normalizePhone(x.phone)).length;
  res.json({
    total: d.total, valid, keys: d.keys,
    sample: d.items.slice(0, 5).map((x) => ({ name: x.name, phone: U.normalizePhone(x.phone) ? U.formatPhone(U.normalizePhone(x.phone)) : x.phone, memo: x.memo })),
  });
});

module.exports = r;
