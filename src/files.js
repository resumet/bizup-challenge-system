'use strict';
// 11장 첨부파일: 형식·크기·실제 유형 검증, 비공개 저장, 권한 검사 후 다운로드
// 업로드 흐름(16.2 "파일 전송 준비와 업로드 완료 확정은 분리"):
//   1) prepare: 파일명·크기·형식 사전 검증 → file_assets(PENDING) + 업로드 대상 발급
//   2) 브라우저가 저장소로 직접 전송
//   3) complete: 서버가 실제 내용을 읽어 매직바이트·크기·매크로 검사 → UPLOADED (실패 시 객체 삭제)
const path = require('path');
const { get, all, run, uuid, now } = require('./db');
const { E } = require('./util');
const { storage } = require('./storage');

const MB = 1024 * 1024;
const LIMITS = {
  attachmentBytes: Number(process.env.MAX_ATTACHMENT_MB || 20) * MB,
  rosterBytes: Number(process.env.MAX_ROSTER_MB || 10) * MB,
  rosterRows: Number(process.env.MAX_ROSTER_ROWS || 5000),
  resourceFiles: 10, resourceLinks: 10, submissionFiles: 5, submissionLinks: 5,
};

const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const isText = (b) => !b.subarray(0, 8192).includes(0);
const ftyp = (b, brands) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && brands.includes(b.subarray(8, 12).toString('latin1'));
const HEIF = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'];
const ATTACHMENT_TYPES = {
  '.pdf': { mime: 'application/pdf', check: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  '.jpg': { mime: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.png': { mime: 'image/png', check: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.webp': { mime: 'image/webp', check: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  '.heic': { mime: 'image/heic', check: (b) => ftyp(b, HEIF) },
  '.heif': { mime: 'image/heif', check: (b) => ftyp(b, HEIF) },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: isZip },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: isZip },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: isZip },
  '.txt': { mime: 'text/plain; charset=utf-8', check: isText },
  '.csv': { mime: 'text/csv; charset=utf-8', check: isText },
  '.hwp': { mime: 'application/x-hwp', check: isOle },
  '.hwpx': { mime: 'application/hwp+zip', check: isZip },
};
const ROSTER_TYPES = { '.xlsx': ATTACHMENT_TYPES['.xlsx'], '.csv': ATTACHMENT_TYPES['.csv'] };
const PURPOSES = {
  resource: { types: ATTACHMENT_TYPES, max: () => LIMITS.attachmentBytes },
  submission: { types: ATTACHMENT_TYPES, max: () => LIMITS.attachmentBytes },
  roster: { types: ROSTER_TYPES, max: () => LIMITS.rosterBytes },
};

// 매크로 포함 OOXML(vbaProject.bin) 거부
const hasMacro = (buf) => buf.includes(Buffer.from('vbaProject.bin'));

function safeName(name) {
  let n = path.basename(String(name || 'file')).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').normalize('NFC').trim();
  if (!n) n = 'file';
  return n.slice(-150);
}

function validateMeta(name, size, purpose) {
  const P = PURPOSES[purpose];
  const n = safeName(name);
  const ext = path.extname(n).toLowerCase();
  if (ext === '.xls') throw E.invalid('오래된 .xls 형식은 지원하지 않습니다. .xlsx 또는 CSV로 변환해주세요.');
  const t = P.types[ext];
  if (!t) throw E.invalid(purpose === 'roster' ? '.xlsx 또는 .csv 파일만 업로드할 수 있습니다.' : '지원하지 않는 파일 형식입니다. 영상·압축파일은 외부 공유 링크로 제출해주세요.');
  const sz = Number(size);
  if (!(sz > 0)) throw E.invalid('빈 파일은 등록할 수 없습니다.');
  if (sz > P.max()) throw E.invalid(`파일 크기는 최대 ${Math.round(P.max() / MB)}MB입니다.`);
  return { name: n, ext, mime: t.mime };
}
function validateContent(buf, f) {
  const P = PURPOSES[f.purpose];
  const ext = path.extname(f.original_name).toLowerCase();
  if (!buf || !buf.length) throw E.invalid('파일이 등록되지 않았습니다. 다시 시도해주세요.');
  if (buf.length > P.max()) throw E.invalid(`파일 크기는 최대 ${Math.round(P.max() / MB)}MB입니다.`);
  if (!P.types[ext].check(buf)) throw E.invalid('파일 내용이 확장자와 일치하지 않습니다.');
  if (isZip(buf) && hasMacro(buf)) throw E.invalid('매크로가 포함된 문서는 등록할 수 없습니다.');
}

// 1) 업로드 준비
async function prepare(user, { name, size, purpose }) {
  const m = validateMeta(name, size, purpose);
  const id = uuid();
  // 경로에 학생 이름·전화번호를 넣지 않는다
  const key = `${purpose}/${new Date().toISOString().slice(0, 7)}/${id}${m.ext}`;
  await run(`INSERT INTO file_assets(id, object_key, original_name, content_type, size, purpose, uploaded_by_type, uploaded_by, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`, id, key, m.name, m.mime, Number(size), purpose, user.type, user.id, 'PENDING', now());
  const f = await get('SELECT * FROM file_assets WHERE id = ?', id);
  return { id, upload: await storage().createUploadTarget(f), max_bytes: PURPOSES[purpose].max() };
}
async function loadOwnPending(user, id) {
  const f = await get('SELECT * FROM file_assets WHERE id = ?', id);
  if (!f || f.uploaded_by_type !== user.type || f.uploaded_by !== user.id) throw E.notFound();
  return f;
}
// 3) 업로드 완료 확정
async function complete(user, id) {
  const f = await loadOwnPending(user, id);
  if (f.status === 'UPLOADED' || f.status === 'ATTACHED') return publicView(f); // 멱등
  if (f.status !== 'PENDING') throw E.invalid('파일이 등록되지 않았습니다. 다시 시도해주세요.');
  let buf;
  try { buf = await storage().read(f.object_key); } catch (_) { throw E.invalid('파일이 등록되지 않았습니다. 다시 시도해주세요.'); }
  try { validateContent(buf, f); } catch (e) {
    await storage().remove(f.object_key);
    await run(`UPDATE file_assets SET status = 'DELETED' WHERE id = ?`, f.id);
    throw e;
  }
  await run(`UPDATE file_assets SET status = 'UPLOADED', size = ? WHERE id = ? AND status = 'PENDING'`, buf.length, f.id);
  return publicView(await get('SELECT * FROM file_assets WHERE id = ?', f.id));
}
const publicView = (f) => ({ id: f.id, original_name: f.original_name, content_type: f.content_type, size: f.size, status: f.status, created_at: f.created_at });

// 11.3 완료되지 않은 임시 업로드 정리(기본 24시간), 명단 원본은 처리 완료 후 30일 보관
async function cleanupTemporaryUploads() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await all(`SELECT * FROM file_assets f WHERE f.status IN ('PENDING','UPLOADED') AND f.purpose != 'roster' AND f.created_at < ?
    AND NOT EXISTS (SELECT 1 FROM assignment_resources r WHERE r.file_id_optional = f.id)
    AND NOT EXISTS (SELECT 1 FROM submission_versions v WHERE v.file_id_optional = f.id) LIMIT 500`, cutoff);
  const rosterCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rosters = await all(`SELECT f.* FROM file_assets f LEFT JOIN import_jobs j ON j.file_id = f.id
    WHERE f.purpose = 'roster' AND f.status != 'DELETED'
      AND ((j.state = 'COMMITTED' AND j.committed_at < ?) OR (j.id IS NULL AND f.created_at < ?)) LIMIT 500`, rosterCutoff, cutoff);
  for (const f of [...rows, ...rosters]) {
    try { await storage().remove(f.object_key); } catch (e) { console.error('cleanup remove failed', f.id, e.message); continue; }
    await run(`UPDATE file_assets SET status = 'DELETED' WHERE id = ?`, f.id);
  }
  return { removed: rows.length + rosters.length };
}

module.exports = { LIMITS, ATTACHMENT_TYPES, ROSTER_TYPES, prepare, complete, loadOwnPending, validateContent, cleanupTemporaryUploads, safeName };
