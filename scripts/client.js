'use strict';
// 간단한 API 클라이언트 (시드·테스트용). 쿠키·CSRF 토큰을 유지한다.
class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, path, body, { raw, headers: extra } = {}) {
    const headers = { ...(extra || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + path, { method, headers, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const m = sc.match(/sid=([^;]*)/);
      if (m) this.cookie = m[1] ? `sid=${m[1]}` : '';
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  async refreshCsrf() { const r = await this.req('GET', '/api/me'); this.csrf = r.data.csrf_token || ''; return r.data; }
  async studentLogin(name, phone) { const r = await this.req('POST', '/api/auth/student/login', { name, phone }); if (r.status === 200) await this.refreshCsrf(); return r; }
  async staffLogin(email, password) { const r = await this.req('POST', '/api/auth/staff/login', { email, password }); if (r.status === 200) await this.refreshCsrf(); return r; }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
  // 업로드: 준비 → 저장소 전송(로컬 저장소) → 완료 확정. 실패 시 해당 단계의 응답을 반환한다.
  async uploadFile(filename, buf, purpose) {
    const prep = await this.post('/api/files/prepare', { name: filename, size: buf.length, purpose });
    if (prep.status !== 201) return prep;
    if (prep.data.upload.type !== 'local') throw new Error('테스트 클라이언트는 로컬 저장소만 지원합니다.');
    const up = await this.req('PUT', prep.data.upload.url, undefined, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
    if (up.status !== 200) return up;
    return this.post(`/api/files/${prep.data.id}/complete`);
  }
}
module.exports = { Client };
