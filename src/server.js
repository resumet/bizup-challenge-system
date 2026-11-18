'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { get } = require('./db');
const { E, AppError, serverNow, setClockOffset, str } = require('./util');
const A = require('./auth');
const F = require('./files');
const AC = require('./access');
const { storage } = require('./storage');

const ON_VERCEL = !!process.env.VERCEL;

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Vercel은 프록시 뒤에서 실행되므로 X-Forwarded-For 의 클라이언트 IP를 신뢰한다(로그인 시도 제한용).
  app.set('trust proxy', process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : ON_VERCEL);

  app.use((req, res, next) => {
    req.requestId = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // 정기 정리 작업(Vercel Cron): CRON_SECRET 으로만 호출 가능. 세션 미들웨어보다 먼저 둔다.
  app.get('/api/cron/cleanup', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.get('authorization') !== `Bearer ${secret}`) throw E.notFound();
    res.json(await F.cleanupTemporaryUploads());
  });

  // 로컬 저장소 전용 업로드 수신 (Supabase Storage 사용 시에는 브라우저가 저장소로 직접 전송)
  app.put('/api/files/:id/upload', express.raw({ type: () => true, limit: F.LIMITS.attachmentBytes + 1024 }), A.sessionMiddleware, A.requireUser, async (req, res) => {
    const s = storage();
    if (s.kind !== 'local') throw E.notFound();
    const f = await F.loadOwnPending(req.user, req.params.id);
    if (f.status !== 'PENDING') throw E.invalid('이미 처리된 업로드입니다.');
    await s.write(f.object_key, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    res.json({ ok: true });
  });

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', A.sessionMiddleware);
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', async (req, res) => {
    await get('SELECT 1 AS ok');
    res.json({ ok: true, server_time: serverNow().toISOString(), storage: storage().kind });
  });
  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: req.user, csrf_token: req.session.csrf_token, server_time: serverNow().toISOString() });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/me', require('./routes/student'));
  app.use('/api', require('./routes/admin'));
  app.use('/api', require('./routes/courses'));
  app.use('/api', require('./routes/challenges'));
  app.use('/api', require('./routes/staffProgress'));

  // 파일 전송 준비와 업로드 완료 확정을 분리한다 (16.2). 제출·자료 연결은 각 API에서 다시 검사한다.
  app.post('/api/files/prepare', A.requireUser, async (req, res) => {
    let purpose = req.user.type === 'STUDENT' ? 'submission' : 'resource';
    if (req.body.purpose === 'roster') {
      if (!(req.user.type === 'STAFF' && req.user.isAdmin)) throw E.forbidden();
      purpose = 'roster';
    }
    res.status(201).json(await F.prepare(req.user, { name: str(req.body.name, 300), size: req.body.size, purpose }));
  });
  app.post('/api/files/:id/complete', A.requireUser, async (req, res) => {
    res.json(await F.complete(req.user, req.params.id));
  });
  app.get('/api/files/:id/download', A.requireUser, async (req, res) => {
    const f = await get('SELECT * FROM file_assets WHERE id = ?', req.params.id);
    if (!f || f.status === 'DELETED' || f.status === 'PENDING' || f.purpose === 'roster') throw E.notFound();
    if (!(await AC.canDownloadFile(req.user, f.id))) throw E.notFound();
    const inline = req.query.inline === '1' && /^image\/(png|jpeg|webp)$/.test(f.content_type);
    await storage().sendDownload(res, f, inline);
  });

  // 검수 환경 전용: 서버 시각 조정 (ENABLE_TEST_CLOCK=1 이고 Vercel 운영 환경이 아닐 때만)
  if (process.env.ENABLE_TEST_CLOCK === '1' && process.env.VERCEL_ENV !== 'production') {
    app.post('/api/test/clock', (req, res) => { setClockOffset(Number(req.body.offset_ms) || 0); res.json({ now: serverNow().toISOString() }); });
  }

  app.use('/api', (req, res, next) => next(E.notFound('요청한 API를 찾을 수 없습니다.')));
  // 로컬 실행 시 정적 파일 제공 (Vercel에서는 public/ 을 CDN이 직접 제공)
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

  // 오류 응답: 요청 추적 ID와 사용자용 메시지. DB 구조·내부 경로는 노출하지 않는다.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = E.invalid('요청 형식이 올바르지 않습니다.');
    if (err.type === 'entity.too.large') err = E.invalid('파일 크기 한도를 초과했습니다.');
    if (!(err instanceof AppError)) {
      if (err.code === '23505') err = E.conflict('이미 처리된 요청이거나 중복된 정보입니다. 새로고침 후 확인해주세요.');
      else if (err.code === '40P01' || err.code === '40001') err = E.conflict('다른 변경과 겹쳤습니다. 잠시 후 다시 시도해주세요.');
      else {
        console.error(`[${req.requestId}]`, err);
        err = new AppError(500, 'INTERNAL', '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
      }
    }
    res.status(err.status).json({ error: { code: err.code, message: err.message, request_id: req.requestId, ...(err.extra || {}) } });
  });
  return app;
}

// 로컬 실행 시 주기 작업 (Vercel에서는 vercel.json 의 Cron이 /api/cron/cleanup 을 호출)
function startBackground() {
  const tick = () => F.cleanupTemporaryUploads().catch((e) => console.error('cleanup failed', e.message));
  tick();
  setInterval(tick, 3600 * 1000).unref();
}

// 다른 프로그램이 이미 응답 중인 포트인지 확인한다.
// (Windows에서는 다른 앱이 IPv4/IPv6 중 한쪽만 점유한 경우 listen이 오류 없이 성공할 수 있어 직접 접속해 본다.)
function isPortBusy(port) {
  const net = require('net');
  const probe = (host) => new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((r) => r.some(Boolean));
}
function listenOnce(app, port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port);
    srv.once('listening', () => resolve(srv));
    srv.once('error', reject);
  });
}
async function startServer(preferredPort, maxTries = 20) {
  const app = createApp();
  for (let port = preferredPort; port < preferredPort + maxTries; port++) {
    if (await isPortBusy(port)) { console.log(`포트 ${port}은(는) 이미 사용 중입니다. 다음 포트를 시도합니다.`); continue; }
    try { return { server: await listenOnce(app, port), port }; } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      console.log(`포트 ${port}을(를) 사용할 수 없습니다(${e.code}). 다음 포트를 시도합니다.`);
    }
  }
  throw new Error(`${preferredPort}~${preferredPort + maxTries - 1} 범위에서 사용 가능한 포트를 찾지 못했습니다.`);
}

if (require.main === module) {
  startServer(Number(process.env.PORT || 3000)).then(async ({ port }) => {
    console.log(`비즈업클래스 챌린지 관리 서비스: http://localhost:${port}`);
    console.log(`DB: ${process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('pglite:') ? 'Postgres(DATABASE_URL)' : 'PGlite(로컬)'} · 파일 저장소: ${storage().kind}`);
    if (!(await get(`SELECT 1 AS ok FROM staff_roles WHERE role = 'ADMIN'`))) {
      console.log('관리자 계정이 없습니다. `npm run init-admin -- --email you@example.com --name 관리자` 로 최초 관리자를 만드세요.');
    }
    startBackground();
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createApp, startBackground, startServer };
