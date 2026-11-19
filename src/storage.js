'use strict';
// 비공개 파일 저장소.
// - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 가 있으면 Supabase Storage(비공개 버킷) 사용
//   · 업로드: 서버가 발급한 서명 업로드 URL로 브라우저가 직접 전송 (Vercel 함수 본문 4.5MB 제한 회피)
//   · 다운로드: 매 요청 권한 확인 후 60초 유효 서명 URL로 리다이렉트
// - 없으면 DATA_DIR/objects 로컬 디스크 사용 (개발·테스트용, 서버가 직접 송수신)
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const BUCKET = process.env.SUPABASE_BUCKET || 'private-files';
const DOWNLOAD_TTL = Number(process.env.SIGNED_URL_TTL_SEC || 60);

function supabaseClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

function supabaseDriver() {
  let client;
  const sb = () => (client || (client = supabaseClient())).storage.from(BUCKET);
  const check = ({ data, error }) => { if (error) throw new Error(`storage: ${error.message}`); return data; };
  return {
    kind: 'supabase',
    async createUploadTarget(f) {
      const d = check(await sb().createSignedUploadUrl(f.object_key));
      return { type: 'supabase', url: d.signedUrl };
    },
    async read(key) {
      const blob = check(await sb().download(key));
      return Buffer.from(await blob.arrayBuffer());
    },
    async remove(key) { await sb().remove([key]); },
    // 화면용: 서명 URL만 발급(파일명은 브라우저가 원래 이름으로 저장). Supabase가 한글 파일명을
    // Content-Disposition filename* 에 이중 인코딩하는 문제를 피하기 위함.
    async downloadUrl(f) {
      return check(await sb().createSignedUrl(f.object_key, DOWNLOAD_TTL)).signedUrl;
    },
    async sendDownload(res, f, inline) {
      const d = check(await sb().createSignedUrl(f.object_key, DOWNLOAD_TTL, inline ? undefined : { download: f.original_name }));
      res.setHeader('Cache-Control', 'private, no-store');
      res.redirect(302, d.signedUrl);
    },
    async ensureBucket() {
      const s = (client || (client = supabaseClient())).storage;
      const { data } = await s.getBucket(BUCKET);
      if (!data) check(await s.createBucket(BUCKET, { public: false, fileSizeLimit: `${Number(process.env.MAX_ATTACHMENT_MB || 20)}MB` }));
      else if (data.public) throw new Error(`버킷 ${BUCKET} 이(가) 공개 상태입니다. 비공개로 변경해주세요.`);
      return BUCKET;
    },
  };
}

function localDriver() {
  const OBJ_DIR = path.join(DATA_DIR, 'objects');
  const p = (key) => {
    const full = path.resolve(OBJ_DIR, key);
    if (!full.startsWith(path.resolve(OBJ_DIR) + path.sep)) throw new Error('invalid key');
    return full;
  };
  return {
    kind: 'local',
    async createUploadTarget(f) { return { type: 'local', url: `/api/files/${f.id}/upload` }; },
    async downloadUrl(f) { return `/api/files/${f.id}/download`; },
    async write(key, buf) {
      fs.mkdirSync(path.dirname(p(key)), { recursive: true });
      fs.writeFileSync(p(key), buf);
    },
    async read(key) { return fs.readFileSync(p(key)); },
    async remove(key) { try { fs.unlinkSync(p(key)); } catch (_) { /* already gone */ } },
    async sendDownload(res, f, inline) {
      const full = p(f.object_key);
      if (!fs.existsSync(full)) { res.status(404).end(); return; }
      res.setHeader('Content-Type', f.content_type);
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      fs.createReadStream(full).pipe(res);
    },
    async ensureBucket() { fs.mkdirSync(OBJ_DIR, { recursive: true }); return OBJ_DIR; },
  };
}

let driver;
function storage() {
  if (!driver) driver = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? supabaseDriver() : localDriver();
  return driver;
}
module.exports = { storage };
