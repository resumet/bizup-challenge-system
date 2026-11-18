'use strict';
// 간단한 API 클라이언트 (시드·테스트용). 쿠키·CSRF 토큰을 유지한다.
class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, path, body, { form } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + path, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const m = sc.match(/sid=([^;]*)/);
      if (m) this.cookie = m[1] ? `sid=${m[1]}` : '';
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  async refreshCsrf() { const r = await this.req('GET', '/api/me'); this.csrf = r.data.csrf_token || ''; return r.data; }
  async studentLogin(name, phone) { const r = await this.req('POST', '/api/auth/student/login', { name, phone }); if (r.status === 200) await this.refreshCsrf(); return r; }
  async staffLogin(email, password) { const r = await this.req('POST', '/api/auth/staff/login', { email, password }); if (r.status === 200) await this.refreshCsrf(); return r; }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
  upload(p, filename, buf, fields = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new Blob([buf]), filename);
    return this.req('POST', p, undefined, { form: fd });
  }
}
module.exports = { Client };
