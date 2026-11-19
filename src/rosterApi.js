'use strict';
// 외부 시스템(API)에서 수강생 명단을 가져온다 (관리자 전용).
// - 관리자가 등록한 연동 소스(URL·인증 헤더·응답 필드 매핑)로 요청하고, 결과는 명단 업로드와 같은
//   미리보기 → 확정 흐름을 거친다(바로 등록하지 않음).
// - 서버가 대신 요청하므로 내부망 접근(SSRF)을 막는다: https만 허용, 사설·루프백·링크로컬 주소 차단,
//   리다이렉트 미추종, 시간·크기 제한.
const dns = require('dns').promises;
const net = require('net');
const { E } = require('./util');

const TIMEOUT_MS = Number(process.env.ROSTER_API_TIMEOUT_MS || 15000);
const MAX_BYTES = Number(process.env.ROSTER_API_MAX_MB || 5) * 1024 * 1024;
// 개발·테스트에서 로컬 모의 서버를 쓰기 위한 예외 (운영에서는 설정하지 말 것)
const ALLOW_PRIVATE = process.env.ROSTER_API_ALLOW_PRIVATE === '1';

const blocked = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));
function isBlockedAddress(ip) {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mapped) return blocked.check(v4mapped[1], 'ipv4');
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw E.invalid('API 주소 형식이 올바르지 않습니다.'); }
  if (u.username || u.password) throw E.invalid('API 주소에 계정 정보를 넣지 말고 인증 헤더를 사용해주세요.');
  if (u.protocol !== 'https:' && !(ALLOW_PRIVATE && u.protocol === 'http:')) throw E.invalid('API 주소는 https:// 로 시작해야 합니다.');
  if (ALLOW_PRIVATE) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }); } catch (_) {
    throw E.invalid('API 주소의 호스트를 찾을 수 없습니다.');
  }
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) throw E.invalid('내부망·사설 주소로는 요청할 수 없습니다.');
  return u;
}

// 자리표시자: {course_code} {course_title} {cohort_label} {param}
function fill(template, vars, encode) {
  return String(template || '').replace(/\{(course_code|course_title|cohort_label|param)\}/g, (_, k) => encode(String(vars[k] ?? '')));
}

function pick(obj, pathStr) {
  if (!pathStr) return obj;
  return String(pathStr).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
const scalar = (v) => (v == null || typeof v === 'object' ? '' : String(v).trim());

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { reader.cancel().catch(() => {}); throw E.invalid(`API 응답이 너무 큽니다. (최대 ${MAX_BYTES / 1024 / 1024}MB)`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// 연동 소스로 요청해 { items: [{name, phone, memo}], total, keys } 를 돌려준다.
async function fetchRoster(src, vars, { maxRows }) {
  const url = await assertSafeUrl(fill(src.url, vars, encodeURIComponent));
  const headers = { accept: 'application/json', 'user-agent': 'bizup-challenge-roster-sync/1.0' };
  for (const [k, v] of Object.entries(JSON.parse(src.headers || '{}'))) headers[k] = v;
  let body;
  if (src.method === 'POST') {
    body = fill(src.body_template || '{}', vars, (s) => JSON.stringify(s).slice(1, -1));
    headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, { method: src.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw E.invalid(e.name === 'TimeoutError' ? `API 응답 시간이 ${TIMEOUT_MS / 1000}초를 넘었습니다.` : 'API에 연결할 수 없습니다. 주소와 네트워크를 확인해주세요.');
  }
  if (res.status >= 300 && res.status < 400) throw E.invalid('API가 다른 주소로 이동(리다이렉트)을 요청했습니다. 최종 주소를 직접 입력해주세요.');
  if (!res.ok) throw E.invalid(`API가 오류를 반환했습니다. (HTTP ${res.status})`);
  const text = await readLimited(res);
  let json;
  try { json = JSON.parse(text); } catch (_) { throw E.invalid('API 응답이 JSON 형식이 아닙니다.'); }
  const list = pick(json, src.items_path);
  if (!Array.isArray(list)) throw E.invalid(src.items_path ? `응답에서 "${src.items_path}" 위치의 목록을 찾을 수 없습니다.` : '응답이 목록(배열)이 아닙니다. 목록 위치를 지정해주세요.');
  if (list.length > maxRows) throw E.invalid(`명단은 최대 ${maxRows}명까지 가져올 수 있습니다. (응답 ${list.length}명)`);
  const first = list.find((x) => x && typeof x === 'object');
  return {
    total: list.length,
    keys: first ? Object.keys(first).slice(0, 50) : [],
    items: list.map((x) => ({
      name: scalar(pick(x, src.name_field)).slice(0, 100),
      phone: scalar(pick(x, src.phone_field)).slice(0, 40),
      memo: src.memo_field ? scalar(pick(x, src.memo_field)).slice(0, 1000) || null : null,
    })),
  };
}

module.exports = { fetchRoster, assertSafeUrl, isBlockedAddress };
