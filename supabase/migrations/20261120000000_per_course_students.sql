-- 수강생 정책 변경: 학생을 전체 시스템이 공유하지 않고 강의마다 따로 둔다.
-- - students.course_id: 학생이 속한 강의 (학생 1명 = 수강 등록 1건)
-- - 전화번호는 강의 안에서만 유일 (다른 강의의 같은 번호는 별개 학생)
-- - 기존에 여러 강의에 등록된 학생은 두 번째 등록부터 강의별 학생으로 복제해 분리한다
-- 다시 실행해도 안전하다 (분리 후에는 학생당 등록이 1건이므로 복제 대상이 없다).

ALTER TABLE students DROP CONSTRAINT IF EXISTS students_normalized_phone_key;
ALTER TABLE students ADD COLUMN IF NOT EXISTS course_id TEXT REFERENCES courses(id);

DO $$
DECLARE
  r record;
  new_id TEXT;
  seq BIGINT;
  t TEXT := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  FOR r IN
    SELECT e.id AS enrollment_id, e.course_id, e.student_id
    FROM enrollments e
    WHERE EXISTS (
      SELECT 1 FROM enrollments e0 WHERE e0.student_id = e.student_id
        AND (e0.enrolled_at, e0.id) < (e.enrolled_at, e.id))  -- 가장 먼저 등록한 1건은 기존 학생에 남긴다
    ORDER BY e.enrolled_at, e.id
  LOOP
    new_id := gen_random_uuid()::text;
    INSERT INTO sequences(name, value) VALUES ('STU', 1)
      ON CONFLICT (name) DO UPDATE SET value = sequences.value + 1 RETURNING value INTO seq;
    INSERT INTO students(id, code, name, normalized_name, normalized_phone, status, course_id, created_at, updated_at)
      SELECT new_id, 'STU-' || lpad(seq::text, 6, '0'), s.name, s.normalized_name, s.normalized_phone, s.status, r.course_id, s.created_at, t
      FROM students s WHERE s.id = r.student_id;
    INSERT INTO student_credentials(student_id, password_hash, credential_version)
      SELECT new_id, c.password_hash, c.credential_version FROM student_credentials c WHERE c.student_id = r.student_id;
    UPDATE enrollments SET student_id = new_id WHERE id = r.enrollment_id;
    UPDATE feedback_reads fr SET student_id = new_id
      FROM feedback f WHERE f.id = fr.feedback_id AND f.enrollment_id = r.enrollment_id AND fr.student_id = r.student_id;
    UPDATE import_rows SET student_id_optional = new_id WHERE enrollment_id_optional = r.enrollment_id;
  END LOOP;
END $$;

UPDATE students s SET course_id = e.course_id FROM enrollments e WHERE e.student_id = s.id AND s.course_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_students_course_phone ON students(course_id, normalized_phone);
CREATE UNIQUE INDEX IF NOT EXISTS ux_enr_one_per_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS ix_students_phone ON students(normalized_phone);
