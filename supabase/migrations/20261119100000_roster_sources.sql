-- 외부 API 명단 연동 (관리자) + 명단 가져오기 출처 구분
CREATE TABLE IF NOT EXISTS roster_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET' CHECK (method IN ('GET','POST')),
  headers TEXT,              -- JSON {이름: 값}. 값은 응답에 노출하지 않는다(인증 토큰 등)
  body_template TEXT,        -- POST 본문 (JSON 문자열, 자리표시자 사용 가능)
  items_path TEXT,           -- 응답 JSON에서 목록 위치 (예: data.students). 비우면 응답 자체가 배열
  name_field TEXT NOT NULL,
  phone_field TEXT NOT NULL,
  memo_field TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'FILE';
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS source_id TEXT;

ALTER TABLE roster_sources ENABLE ROW LEVEL SECURITY;
