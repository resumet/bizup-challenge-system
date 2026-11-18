'use strict';
// Vercel 서버리스 함수 진입점: /api/* 요청을 Express 앱으로 처리한다 (vercel.json rewrites 참고).
// 정적 파일(public/)은 Vercel CDN이 직접 제공한다.
const { createApp } = require('../src/server');

module.exports = createApp();
