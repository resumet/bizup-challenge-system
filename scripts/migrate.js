'use strict';
// DB 스키마 적용 + 파일 버킷 준비. 여러 번 실행해도 안전하다(IF NOT EXISTS).
// 사용: npm run db:migrate  (DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 필요)
// Vercel 빌드에서도 실행된다(vercel-build). 건너뛰려면 SKIP_MIGRATE=1.
const { migrate, close, driver } = require('../src/db');
const { storage } = require('../src/storage');

(async () => {
  if (process.env.SKIP_MIGRATE === '1') { console.log('SKIP_MIGRATE=1: 마이그레이션을 건너뜁니다.'); return; }
  if (process.env.VERCEL && !process.env.DATABASE_URL) {
    console.error('DATABASE_URL이 설정되지 않았습니다. Vercel 프로젝트의 Environment Variables에 등록해주세요.');
    process.exit(1);
  }
  const d = await driver();
  await migrate();
  console.log(`DB 스키마 적용 완료 (${d.kind})`);
  const s = storage();
  if (process.env.VERCEL && s.kind !== 'supabase') {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 설정되지 않았습니다. Vercel에서는 파일 저장에 Supabase Storage가 필요합니다.');
    process.exit(1);
  }
  console.log(`파일 저장소 준비 완료 (${s.kind}: ${await s.ensureBucket()})`);
  await close();
})().catch((e) => { console.error('마이그레이션 실패:', e.message); process.exit(1); });
