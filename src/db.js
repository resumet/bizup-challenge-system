'use strict';
// SQLite(node:sqlite) 기반 데이터 계층. PRD 15장 논리 데이터 모델을 구현한다.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS staff_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','DISABLED')),
  credential_version INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_roles (
  staff_id TEXT NOT NULL REFERENCES staff_accounts(id),
  role TEXT NOT NULL CHECK (role IN ('ADMIN','INSTRUCTOR')),
  PRIMARY KEY (staff_id, role)
);
CREATE TABLE IF NOT EXISTS instructors (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  staff_id TEXT NOT NULL UNIQUE REFERENCES staff_accounts(id),
  name TEXT NOT NULL,
  phone_optional TEXT
);
CREATE TABLE IF NOT EXISTS staff_tokens (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff_accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  normalized_phone TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS student_credentials (
  student_id TEXT PRIMARY KEY REFERENCES students(id),
  password_hash TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  cohort_label TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL CHECK (state IN ('READY','ACTIVE','ENDED','ARCHIVED')),
  starts_on TEXT,
  ends_on TEXT,
  admin_memo TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS course_instructors (
  course_id TEXT NOT NULL REFERENCES courses(id),
  instructor_id TEXT NOT NULL REFERENCES instructors(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REMOVED')),
  assigned_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (course_id, instructor_id)
);
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  enrolled_at TEXT NOT NULL,
  deactivated_at TEXT,
  reason TEXT,
  admin_memo TEXT,
  UNIQUE (course_id, student_id),
  UNIQUE (id, course_id)
);
CREATE TABLE IF NOT EXISTS enrollment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
  action TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  allow_after_deadline INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL CHECK (visibility IN ('DRAFT','PUBLISHED')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, updated_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (id, course_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  submission_required INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL CHECK (visibility IN ('DRAFT','PUBLISHED')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  copied_from_id TEXT,
  locked_at TEXT,
  published_at TEXT,
  has_feedback_history INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT, updated_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (challenge_id, course_id) REFERENCES challenges(id, course_id),
  UNIQUE (id, course_id)
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, assignment_id)
);
CREATE TABLE IF NOT EXISTS task_progress (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  started_at TEXT,
  is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  completed_deadline_at TEXT,
  completion_timing TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (enrollment_id, course_id) REFERENCES enrollments(id, course_id),
  FOREIGN KEY (assignment_id, course_id) REFERENCES assignments(id, course_id),
  UNIQUE (enrollment_id, assignment_id),
  UNIQUE (id, assignment_id)
);
CREATE TABLE IF NOT EXISTS item_progress (
  task_progress_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  checklist_item_id TEXT NOT NULL,
  is_checked INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  PRIMARY KEY (task_progress_id, checklist_item_id),
  FOREIGN KEY (task_progress_id, assignment_id) REFERENCES task_progress(id, assignment_id),
  FOREIGN KEY (checklist_item_id, assignment_id) REFERENCES checklist_items(id, assignment_id)
);
CREATE TABLE IF NOT EXISTS progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_progress_id TEXT NOT NULL REFERENCES task_progress(id),
  event_type TEXT NOT NULL,
  item_id_optional TEXT,
  submission_id_optional TEXT,
  occurred_at TEXT NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS file_assets (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  uploaded_by_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UPLOADED','ATTACHED','DELETED')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignment_resources (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  type TEXT NOT NULL CHECK (type IN ('FILE','LINK')),
  file_id_optional TEXT REFERENCES file_assets(id),
  url_optional TEXT,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  CHECK ((type='FILE' AND file_id_optional IS NOT NULL) OR (type='LINK' AND url_optional IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('FILE','LINK')),
  current_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('READY','REMOVED')),
  submitted_at TEXT NOT NULL,
  removed_at TEXT,
  idempotency_key TEXT,
  FOREIGN KEY (enrollment_id, course_id) REFERENCES enrollments(id, course_id),
  FOREIGN KEY (assignment_id, course_id) REFERENCES assignments(id, course_id),
  UNIQUE (enrollment_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS submission_versions (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  revision INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('FILE','LINK')),
  file_id_optional TEXT REFERENCES file_assets(id),
  url_optional TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (submission_id, revision),
  CHECK ((type='FILE' AND file_id_optional IS NOT NULL) OR (type='LINK' AND url_optional IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  author_staff_id TEXT NOT NULL REFERENCES staff_accounts(id),
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (enrollment_id, course_id) REFERENCES enrollments(id, course_id),
  FOREIGN KEY (assignment_id, course_id) REFERENCES assignments(id, course_id)
);
CREATE TABLE IF NOT EXISTS feedback_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT NOT NULL REFERENCES feedback(id),
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  body TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_submission_refs (
  feedback_id TEXT NOT NULL REFERENCES feedback(id),
  submission_id TEXT NOT NULL,
  submission_revision INTEGER NOT NULL,
  PRIMARY KEY (feedback_id, submission_id),
  FOREIGN KEY (submission_id, submission_revision) REFERENCES submission_versions(submission_id, revision)
);
CREATE TABLE IF NOT EXISTS feedback_reads (
  feedback_id TEXT NOT NULL REFERENCES feedback(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  last_read_version INTEGER NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (feedback_id, student_id)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  uploaded_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PREVIEW','COMMITTING','COMMITTED')),
  file_id TEXT REFERENCES file_assets(id),
  file_hash TEXT,
  original_name TEXT,
  sheet_names TEXT,
  sheet_name TEXT,
  headers TEXT,
  mapping TEXT,
  idempotency_key TEXT UNIQUE,
  counts TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE TABLE IF NOT EXISTS import_rows (
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  row_number INTEGER NOT NULL,
  raw_name TEXT,
  raw_phone TEXT,
  memo TEXT,
  normalized_name TEXT,
  normalized_phone TEXT,
  classification TEXT NOT NULL,
  error TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  result_message TEXT,
  student_id_optional TEXT,
  enrollment_id_optional TEXT,
  PRIMARY KEY (import_job_id, row_number)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  course_id_optional TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  action TEXT NOT NULL,
  changed_fields TEXT,
  reason TEXT,
  restricted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('STUDENT','STAFF')),
  subject_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS ix_ci_instructor ON course_instructors(instructor_id, status);
CREATE INDEX IF NOT EXISTS ix_enr_course ON enrollments(course_id, status);
CREATE INDEX IF NOT EXISTS ix_enr_student ON enrollments(student_id, status);
CREATE INDEX IF NOT EXISTS ix_ch_course ON challenges(course_id, visibility);
CREATE INDEX IF NOT EXISTS ix_as_course ON assignments(course_id, visibility);
CREATE INDEX IF NOT EXISTS ix_as_challenge ON assignments(challenge_id);
CREATE INDEX IF NOT EXISTS ix_items_as ON checklist_items(assignment_id);
CREATE INDEX IF NOT EXISTS ix_tp_as ON task_progress(assignment_id);
CREATE INDEX IF NOT EXISTS ix_tp_course ON task_progress(course_id, is_completed);
CREATE INDEX IF NOT EXISTS ix_sub_enr ON submissions(enrollment_id, assignment_id, status);
CREATE INDEX IF NOT EXISTS ix_fb_enr ON feedback(enrollment_id, assignment_id);
CREATE INDEX IF NOT EXISTS ix_fb_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS ix_res_as ON assignment_resources(assignment_id);
CREATE INDEX IF NOT EXISTS ix_res_file ON assignment_resources(file_id_optional);
CREATE INDEX IF NOT EXISTS ix_subv_file ON submission_versions(file_id_optional);
CREATE INDEX IF NOT EXISTS ix_audit_course ON audit_logs(course_id_optional, created_at);
CREATE INDEX IF NOT EXISTS ix_sess_subject ON sessions(subject_type, subject_id);
`;
db.exec(SCHEMA);

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const get = (sql, ...p) => prep(sql).get(...p.map(norm));
const all = (sql, ...p) => prep(sql).all(...p.map(norm));
const run = (sql, ...p) => prep(sql).run(...p.map(norm));

let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    txDepth--;
  }
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// 표시번호 발급: CRS-000001 등. 재사용하지 않는다.
function nextCode(prefix) {
  return tx(() => {
    const row = get('SELECT value FROM sequences WHERE name = ?', prefix);
    const v = (row ? row.value : 0) + 1;
    run('INSERT INTO sequences(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', prefix, v);
    return `${prefix}-${String(v).padStart(6, '0')}`;
  });
}

module.exports = { db, get, all, run, tx, uuid, now, nextCode, DATA_DIR };
