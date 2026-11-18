'use strict';
const crypto = require('crypto');

class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const E = {
  unauth: (m = '로그인이 필요합니다.') => new AppError(401, 'UNAUTHENTICATED', m),
  forbidden: (m = '이 작업을 수행할 권한이 없습니다.') => new AppError(403, 'FORBIDDEN', m),
  // 범위 밖 객체는 존재 여부를 드러내지 않도록 404로 응답한다.
  notFound: (m = '요청한 정보를 찾을 수 없거나 접근할 수 없습니다.') => new AppError(404, 'NOT_FOUND', m),
  invalid: (m, extra) => new AppError(400, 'VALIDATION_ERROR', m, extra),
  conflict: (m, extra) => new AppError(409, 'CONFLICT', m, extra),
  rate: (m = '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.') => new AppError(429, 'RATE_LIMITED', m),
};

// 4.3 전화번호 정규화. 유효하지 않으면 null.
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/[\s\-(). ]/g, '');
  if (s.startsWith('+82')) {
    s = s.slice(3);
    if (!s.startsWith('0')) s = '0' + s;
  }
  if (!/^\d+$/.test(s)) return null;
  if (/^010\d{8}$/.test(s)) return s;
  if (/^01[16789]\d{7,8}$/.test(s)) return s;
  return null;
}
function phoneError(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '전화번호가 비어 있습니다.';
  const digits = raw.replace(/\D/g, '');
  if (/^1[016789]\d{7,8}$/.test(digits)) {
    return '전화번호 형식을 확인해주세요. Excel에서 전화번호 열을 텍스트로 설정해주세요. (앞자리 0 유실 의심)';
  }
  if (/[eE]\+/.test(raw)) return '전화번호 형식을 확인해주세요. Excel에서 전화번호 열을 텍스트로 설정해주세요. (숫자 손상)';
  return '전화번호 형식을 확인해주세요. 국내 휴대전화 번호만 등록할 수 있습니다.';
}
function normalizeName(input) {
  if (input === null || input === undefined) return '';
  return String(input).normalize('NFC').trim().replace(/\s+/g, ' ');
}
function maskPhone(p) {
  if (!p) return '';
  if (p.length === 11) return `${p.slice(0, 3)}-****-${p.slice(7)}`;
  return `${p.slice(0, 3)}-***-${p.slice(6)}`;
}
function formatPhone(p) {
  if (!p) return '';
  if (p.length === 11) return `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`;
  return `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`;
}

// 8.2 날짜와 마감 경계 (KST = UTC+9, 서머타임 없음)
const KST_OFFSET_MS = 9 * 3600 * 1000;
function isValidDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
}
function kstDateStartUtc(d) {
  return new Date(Date.parse(d + 'T00:00:00Z') - KST_OFFSET_MS).toISOString();
}
function kstDeadlineUtc(endDate) {
  return new Date(Date.parse(endDate + 'T00:00:00Z') - KST_OFFSET_MS + 86400000).toISOString();
}

// 테스트·검수용 서버 시각 오프셋(운영에서는 사용하지 않음)
let clockOffsetMs = Number(process.env.CLOCK_OFFSET_MS || 0);
function serverNow() { return new Date(Date.now() + clockOffsetMs); }
function setClockOffset(ms) { clockOffsetMs = ms; }

function isSafeUrl(u) {
  if (typeof u !== 'string' || u.length > 2000) return false;
  try {
    const x = new URL(u.trim());
    return (x.protocol === 'http:' || x.protocol === 'https:') && !!x.hostname;
  } catch { return false; }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

function str(v, max = 10000) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (s.length > max) throw E.invalid(`입력이 너무 깁니다. (최대 ${max}자)`);
  return s;
}
function requireStr(v, label, max = 200) {
  const s = (str(v, max) || '').trim();
  if (!s) throw E.invalid(`${label}을(를) 입력해주세요.`);
  return s;
}
function pageParams(q) {
  const allowed = [20, 50, 100];
  let size = parseInt(q.size, 10);
  if (!allowed.includes(size)) size = 50;
  let page = parseInt(q.page, 10);
  if (!(page >= 1)) page = 1;
  return { page, size, offset: (page - 1) * size };
}
function pct(done, total) {
  if (!total) return null;
  return Math.round((done / total) * 1000) / 10;
}

module.exports = {
  AppError, E, normalizePhone, phoneError, normalizeName, maskPhone, formatPhone,
  isValidDate, kstDateStartUtc, kstDeadlineUtc, serverNow, setClockOffset,
  isSafeUrl, sha256, randomToken, str, requireStr, pageParams, pct,
};
