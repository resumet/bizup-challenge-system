'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { get, all } = require('./db');
const { E, AppError, serverNow, setClockOffset } = require('./util');
const A = require('./auth');
const F = require('./files');
const AC = require('./access');
const courses = require('./routes/courses');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');

  app.use((req, res, next) => {
    req.requestId = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', A.sessionMiddleware);
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', (req, res) => res.json({ ok: true, server_time: serverNow().toISOString() }));
  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: req.user, csrf_token: req.session.csrf_token, server_time: serverNow().toISOString() });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/me', require('./routes/student'));
  app.use('/api', require('./routes/admin'));
  app.use('/api', courses);
  app.use('/api', require('./routes/challenges'));
  app.use('/api', require('./routes/staffProgress'));

  // 파일 업로드(전송 준비)와 제출 확정은 분리한다.
  app.post('/api/files', A.requireUser, F.uploadAttachment, (req, res) => {
    const purpose = req.user.type === 'STUDENT' ? 'submission' : 'resource';
    const f = F.store(req.file, { types: F.ATTACHMENT_TYPES, maxBytes: F.LIMITS.attachmentBytes, purpose, user: req.user });
    res.status(201).json(f);
  });
  app.get('/api/files/:id/download', A.requireUser, (req, res) => {
    const f = get('SELECT * FROM file_assets WHERE id = ?', req.params.id);
    if (!f || f.status === 'DELETED' || f.purpose === 'roster' && !(req.user.type === 'STAFF' && req.user.isAdmin)) throw E.notFound();
    if (!AC.canDownloadFile(req.user, f.id)) throw E.notFound();
    const p = F.objectPath(f);
    if (!fs.existsSync(p)) throw E.notFound();
    const inline = req.query.inline === '1' && /^image\/(png|jpeg|webp)$/.test(f.content_type);
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(p).pipe(res);
  });

  // 검수 환경 전용: 서버 시각 조정 (ENABLE_TEST_CLOCK=1 일 때만)
  if (process.env.ENABLE_TEST_CLOCK === '1') {
    app.post('/api/test/clock', (req, res) => { setClockOffset(Number(req.body.offset_ms) || 0); res.json({ now: serverNow().toISOString() }); });
  }

  app.use('/api', (req, res, next) => next(E.notFound('요청한 API를 찾을 수 없습니다.')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // 오류 응답: 요청 추적 ID와 사용자용 메시지. DB 구조·내부 경로는 노출하지 않는다.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = E.invalid('요청 형식이 올바르지 않습니다.');
    if (!(err instanceof AppError)) {
      if (/UNIQUE constraint failed/.test(err.message || '')) err = E.conflict('이미 처리된 요청이거나 중복된 정보입니다. 새로고침 후 확인해주세요.');
      else {
        console.error(`[${req.requestId}]`, err);
        err = new AppError(500, 'INTERNAL', '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
      }
    }
    res.status(err.status).json({ error: { code: err.code, message: err.message, request_id: req.requestId, ...(err.extra || {}) } });
  });
  return app;
}

function startBackground() {
  // 서버 재시작 시 확정 중이던 명단 처리를 이어서 수행 (이미 등록된 행은 중복 생성되지 않음)
  for (const j of all(`SELECT id, uploaded_by FROM import_jobs WHERE state = 'COMMITTING'`)) {
    const a = get('SELECT id, name FROM staff_accounts WHERE id = ?', j.uploaded_by);
    courses.processCommit({ user: { type: 'STAFF', id: a.id, name: a.name } }, j.id).catch((e) => console.error(e));
  }
  F.cleanupTemporaryUploads();
  setInterval(() => { try { F.cleanupTemporaryUploads(); } catch (e) { console.error(e); } }, 3600 * 1000).unref();
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
  startServer(Number(process.env.PORT || 3000)).then(({ port }) => {
    console.log(`비즈업클래스 챌린지 관리 서비스: http://localhost:${port}`);
    if (!get(`SELECT 1 FROM staff_roles WHERE role = 'ADMIN'`)) {
      console.log('관리자 계정이 없습니다. `npm run init-admin -- --email you@example.com --name 관리자` 로 최초 관리자를 만드세요.');
    }
    startBackground();
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createApp, startBackground, startServer };
