'use strict';
// 11장 첨부파일: 형식·크기·실제 유형 검증, 비공개 저장, 권한 검사 후 다운로드
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { get, all, run, uuid, now, DATA_DIR } = require('./db');
const { E } = require('./util');

const OBJ_DIR = path.join(DATA_DIR, 'objects');
fs.mkdirSync(OBJ_DIR, { recursive: true });

const MB = 1024 * 1024;
const LIMITS = {
  attachmentBytes: Number(process.env.MAX_ATTACHMENT_MB || 20) * MB,
  rosterBytes: Number(process.env.MAX_ROSTER_MB || 10) * MB,
  rosterRows: Number(process.env.MAX_ROSTER_ROWS || 5000),
  resourceFiles: 10, resourceLinks: 10, submissionFiles: 5, submissionLinks: 5,
};

const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b) => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const isText = (b) => !b.slice(0, 8192).includes(0);
const ftyp = (b, brands) => b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp' && brands.includes(b.slice(8, 12).toString('latin1'));
const ATTACHMENT_TYPES = {
  '.pdf': { mime: 'application/pdf', check: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  '.jpg': { mime: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.png': { mime: 'image/png', check: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.webp': { mime: 'image/webp', check: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  '.heic': { mime: 'image/heic', check: (b) => ftyp(b, ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis']) },
  '.heif': { mime: 'image/heif', check: (b) => ftyp(b, ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis']) },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: isZip },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: isZip },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: isZip },
  '.txt': { mime: 'text/plain; charset=utf-8', check: isText },
  '.csv': { mime: 'text/csv; charset=utf-8', check: isText },
  '.hwp': { mime: 'application/x-hwp', check: isOle },
  '.hwpx': { mime: 'application/hwp+zip', check: isZip },
};
const ROSTER_TYPES = { '.xlsx': ATTACHMENT_TYPES['.xlsx'], '.csv': ATTACHMENT_TYPES['.csv'] };

// 매크로 포함 OOXML(vbaProject.bin) 거부
function hasMacro(buf) { return buf.includes(Buffer.from('vbaProject.bin')); }

function safeName(name) {
  let n = Buffer.from(String(name || 'file'), 'latin1').toString('utf8'); // multer는 latin1로 디코딩함
  if (n.includes('�')) n = String(name || 'file');
  n = path.basename(n).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').normalize('NFC').trim();
  if (!n) n = 'file';
  return n.slice(-150);
}

function validate(file, types, maxBytes) {
  if (!file) throw E.invalid('파일을 선택해주세요.');
  const name = safeName(file.originalname);
  const ext = path.extname(name).toLowerCase();
  if (ext === '.xls') throw E.invalid('오래된 .xls 형식은 지원하지 않습니다. .xlsx 또는 CSV로 변환해주세요.');
  const t = types[ext];
  if (!t) throw E.invalid('지원하지 않는 파일 형식입니다. 영상·압축파일은 외부 공유 링크로 제출해주세요.');
  if (file.size > maxBytes) throw E.invalid(`파일 크기는 최대 ${Math.round(maxBytes / MB)}MB입니다.`);
  if (file.size === 0) throw E.invalid('빈 파일은 등록할 수 없습니다.');
  if (!t.check(file.buffer)) throw E.invalid('파일 내용이 확장자와 일치하지 않습니다.');
  if (isZip(file.buffer) && hasMacro(file.buffer)) throw E.invalid('매크로가 포함된 문서는 등록할 수 없습니다.');
  return { name, mime: t.mime };
}

function store(file, { types, maxBytes, purpose, user }) {
  const { name, mime } = validate(file, types, maxBytes);
  const id = uuid();
  const key = `${new Date().toISOString().slice(0, 7)}/${id}`; // 경로에 학생 이름·전화번호를 넣지 않는다
  fs.mkdirSync(path.join(OBJ_DIR, path.dirname(key)), { recursive: true });
  fs.writeFileSync(path.join(OBJ_DIR, key), file.buffer, { flag: 'wx' });
  run(`INSERT INTO file_assets(id, object_key, original_name, content_type, size, purpose, uploaded_by_type, uploaded_by, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`, id, key, name, mime, file.size, purpose, user.type, user.id, 'UPLOADED', now());
  return get('SELECT id, original_name, content_type, size, status, created_at FROM file_assets WHERE id = ?', id);
}

function objectPath(f) {
  const p = path.resolve(OBJ_DIR, f.object_key);
  if (!p.startsWith(path.resolve(OBJ_DIR) + path.sep)) throw E.notFound();
  return p;
}

const uploadAttachment = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.attachmentBytes + 1, files: 1 } }).single('file');
const uploadRoster = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.rosterBytes + 1, files: 1 } }).single('file');
function wrapMulter(mw) {
  return (req, res, next) => mw(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return next(E.invalid('파일 크기 한도를 초과했습니다.'));
    if (err) return next(E.invalid('파일이 등록되지 않았습니다. 다시 시도해주세요.'));
    next();
  });
}

// 11.3 완료되지 않은 임시 업로드 정리(기본 24시간)
function cleanupTemporaryUploads() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = all(`SELECT * FROM file_assets WHERE status = 'UPLOADED' AND purpose != 'roster' AND created_at < ?`, cutoff);
  for (const f of rows) {
    const used = get(`SELECT 1 FROM assignment_resources WHERE file_id_optional = ? UNION SELECT 1 FROM submission_versions WHERE file_id_optional = ?`, f.id, f.id);
    if (used) continue;
    try { fs.unlinkSync(objectPath(f)); } catch (_) { /* already gone */ }
    run(`UPDATE file_assets SET status = 'DELETED' WHERE id = ?`, f.id);
  }
  // 18.3 명단 원본은 처리 완료 후 30일간 보관
  const rosterCutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rosters = all(`SELECT f.* FROM file_assets f JOIN import_jobs j ON j.file_id = f.id
    WHERE f.purpose = 'roster' AND f.status != 'DELETED' AND j.state = 'COMMITTED' AND j.committed_at < ?`, rosterCutoff);
  for (const f of rosters) {
    try { fs.unlinkSync(objectPath(f)); } catch (_) { /* ignore */ }
    run(`UPDATE file_assets SET status = 'DELETED' WHERE id = ?`, f.id);
  }
}

module.exports = {
  LIMITS, ATTACHMENT_TYPES, ROSTER_TYPES, store, objectPath, validate, safeName,
  uploadAttachment: wrapMulter(uploadAttachment), uploadRoster: wrapMulter(uploadRoster), cleanupTemporaryUploads,
};
