# 비즈업클래스 유료 수강생·챌린지 관리 서비스

`docs/비즈업클래스_유료수강생_챌린지관리_PRD_v1.0.md`를 구현한 웹 서비스입니다.

| 구분 | 구성 |
|---|---|
| 백엔드 | Node.js 22.13+ · Express 5 (Vercel 서버리스 함수 `api/index.js`) |
| DB | **Supabase Postgres** (`pg`). 로컬·테스트는 설치가 필요 없는 PGlite(WASM Postgres) |
| 파일 | **Supabase Storage** 비공개 버킷. 로컬은 `data/objects` |
| 프런트엔드 | 빌드가 필요 없는 바닐라 JS SPA (`public/`, Vercel CDN이 제공) |
| 배포 | GitHub `main` 푸시 → **Vercel 자동 배포** (빌드 중 DB 마이그레이션) |
| CI | GitHub Actions: PGlite와 실제 Postgres 16 두 가지 DB로 테스트 |

## 로컬 실행

```bash
npm install
npm run seed      # 데모 데이터 (빈 DB에서)
npm start         # http://localhost:3000. 포트가 사용 중이면 3001, 3002… 순서로 빈 포트를 찾아 시작
```

`.env`가 없으면 `data/pgdata`(PGlite)와 `data/objects`를 사용합니다. Supabase에 연결해서 실행하려면 `.env.example`을 `.env`로 복사한 뒤 값을 채우고 `npm run db:migrate`를 먼저 실행하세요.

- 데모 계정: 관리자 `admin@bizup.local` / `admin1234!`, 강사 `teacher@bizup.local` / `teacher1234!`, 수강생 `김민수` / `01011112222`
- 최초 관리자: `npm run init-admin -- --email you@example.com --name 관리자 [--password …] [--base-url https://배포주소]`
- 테스트: `npm test` (PGlite). 실제 Postgres로 돌리려면 `TEST_DATABASE_URL=postgres://… npm test` (빈 DB 사용)

## 배포 (Supabase + Vercel)

### 1. Supabase 프로젝트
1. https://supabase.com 에서 프로젝트를 만듭니다. 리전은 Northeast Asia (Seoul) `ap-northeast-2`를 권장합니다.
2. **Project Settings → Database → Connection string → Transaction pooler** (포트 6543) 주소를 복사해 `DATABASE_URL`로 씁니다.
3. **Project Settings → API**에서 `Project URL`(`SUPABASE_URL`)과 `service_role` 키(`SUPABASE_SERVICE_ROLE_KEY`)를 확인합니다.
   - `service_role` 키는 서버 전용입니다. 브라우저 코드나 git에 넣지 마세요.
4. 스키마와 버킷은 Vercel 빌드에서 자동으로 적용됩니다. 미리 적용하려면 로컬 `.env`에 위 값을 넣고 `npm run db:migrate`를 실행합니다.
   - Supabase SQL Editor에서 `supabase/migrations/`의 SQL 파일을 이름 순서대로 실행해도 됩니다. 모든 파일은 다시 실행해도 안전하게 작성되어 있습니다.
   - 모든 테이블은 RLS가 켜져 있고 정책이 없어서 anon·authenticated 키(PostgREST)로는 접근할 수 없습니다.

### 2. Vercel 프로젝트 (GitHub 자동 배포)
1. https://vercel.com/new 에서 `resumet/bizup-challenge-system` 저장소를 Import 합니다.
   - Framework Preset은 **Other**로 둡니다. 빌드·출력 설정은 `vercel.json`이 지정합니다.
2. **Settings → Environment Variables**에 다음을 등록합니다(Production 및 필요 시 Preview).

   | 이름 | 값 |
   |---|---|
   | `DATABASE_URL` | Supabase Transaction pooler 주소 |
   | `SUPABASE_URL` | Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role 키 |
   | `CRON_SECRET` | 임의의 긴 문자열 (예: `openssl rand -hex 32`) |

3. Deploy를 누릅니다. 이후에는 `main`에 푸시할 때마다 자동으로 배포되고, PR·브랜치에는 Preview 배포가 만들어집니다.
4. 최초 관리자를 만듭니다. 로컬 `.env`에 운영 DB 값을 넣고 아래 명령을 실행합니다.
   ```bash
   npm run init-admin -- --email you@example.com --name 관리자 --base-url https://<배포주소>
   ```
   출력된 설정 링크로 비밀번호를 정합니다.

> **Preview 배포 주의:** Preview 환경에 운영 DB 값을 넣으면 미리보기 배포가 운영 데이터를 읽고 씁니다. Preview에는 별도의 Supabase 프로젝트(또는 branch)를 연결하거나, 해당 값을 Production에만 등록하세요. 빌드 중 마이그레이션을 건너뛰려면 `SKIP_MIGRATE=1`을 설정합니다.

### 서버리스 환경에서 바뀐 동작
- **파일 업로드**: 브라우저가 서버에서 서명 업로드 URL을 받아 Supabase Storage로 직접 올립니다. 서버는 그 후 실제 내용(매직바이트·크기·매크로)을 검사해 확정합니다. Vercel 함수 본문 4.5MB 제한을 피하기 위한 방식입니다.
- **파일 다운로드**: 요청마다 권한을 확인한 뒤 **60초 동안만 유효한** 서명 URL을 발급합니다. 화면에서는 이 URL로 받은 파일을 원래 파일명으로 저장합니다(Supabase가 한글 파일명을 이중 인코딩하는 문제 회피). 링크를 새 탭으로 열면 서명 URL로 리다이렉트합니다. 영구 공개 URL은 없습니다. 이미 발급된 URL은 60초 안에는 권한을 회수해도 열릴 수 있습니다(PRD 11.2 참고, `SIGNED_URL_TTL_SEC`로 조정).
- **명단 확정**: 함수 실행 시간 제한 때문에 서버가 호출마다 약 8초 분량만 처리하고, 화면이 남은 행을 이어서 요청합니다. 중간에 화면을 떠났다가 돌아와도 이어서 처리됩니다.
- **정리 작업**: 미완료 업로드(24시간)와 명단 원본(30일) 정리는 Vercel Cron이 매일 03:00 KST에 `/api/cron/cleanup`을 호출해 수행합니다.
- **로그인 시도 제한**: 인스턴스 간에 공유되도록 DB(`login_attempts`)에 저장합니다.

## 화면
| 사용자 | 경로 |
|---|---|
| 수강생 로그인 | `/#/login` (이름 + 전화번호) |
| 강사·관리자 로그인 | `/#/staff-login` (이메일 + 비밀번호) |
| 계정 설정 링크 | `/#/setup/<token>` (관리자가 발급, 24시간·1회용) |

## 구현 요약 (PRD 대응)
- **고유번호**: 강의 `CRS-`, 강사 `INS-`, 학생 `STU-`
- **수강생은 강의마다 따로 둡니다** (2026-11 정책 변경, 마이그레이션 `20261120000000_per_course_students.sql`)
  - 학생 1명 = 한 강의의 수강 등록 1건(`students.course_id`). 전화번호는 **강의 안에서만** 유일합니다.
  - 같은 사람이 두 강의를 들으면 강의별 학생(학생번호)이 각각 생기고, 다른 강의에서 무엇을 들었는지는 기록하지 않습니다.
  - 수강생 로그인: 이름·전화번호가 맞는 강의가 여러 개면 강의를 고른 뒤 그 강의로만 입장합니다. 다른 강의는 로그아웃 후 다시 선택합니다.
  - **관리자만** `전체 수강생`에서 모든 강의의 수강생을 보고, 같은 전화번호를 가진 수강생이 어떤 강의를 들었는지 확인할 수 있습니다(저장된 연결이 아니라 전화번호로 조회). 강사에게는 보이지 않습니다.
  - 이전 정책 데이터는 마이그레이션이 두 번째 등록부터 강의별 학생으로 복제해 분리합니다(로그인 정보·진행 기록·피드백 읽음 유지).
- **수강생 등록 (2가지 경로)**
  - **관리자**: 개별 등록, 엑셀 업로드, **외부 API 가져오기**(메뉴 `외부 연동`에서 연동 소스 등록 → 강의 수강생 탭의 `외부 API 가져오기`)
  - **담당 강사**: 자신이 배정된 강의에서만 엑셀 업로드, 개별 등록, 수정, 삭제·비활성화
    - 수정: 사유가 필수이고, 로그인 정보가 바뀌면 학생 세션이 취소됩니다. 이 강의의 학생에게만 반영됩니다.
    - 삭제: 과제 수행·제출·피드백 기록이 없을 때만 가능합니다. 기록이 있으면 비활성화로 안내합니다. 학생 정보까지 함께 삭제합니다.
    - 등록 메모는 관리자 전용이라 강사 입력값은 저장하지 않습니다.
- **명단 업로드**: xlsx/csv(UTF-8·CP949) → 열 매핑 → 미리보기(DB 미생성) → 행 수정·제외 → 확정(재검사, 행 단위 트랜잭션)
- **외부 API 가져오기**: 연동 소스(주소, GET/POST, 인증 헤더, 목록 위치 `data.students`, 이름·전화번호·메모 필드)로 요청한 결과를 엑셀과 같은 미리보기 → 확정 흐름으로 등록합니다.
  - 주소·본문 자리표시자: `{course_code}` `{course_title}` `{cohort_label}` `{param}`
  - 인증 헤더 값은 화면·API 응답에 다시 내려보내지 않습니다. 다만 DB(`roster_sources`)에는 평문으로 저장되므로 읽기 전용·최소 권한 토큰을 쓰세요.
  - 서버가 대신 요청하므로 https만 허용하고, 사설·루프백·링크로컬 주소와 리다이렉트를 차단합니다. 응답은 15초, 5MB, 5,000명까지 받습니다.
- **챌린지·과제**: 초안/공개, 한국 시간 기준 기간(종료일 다음 날 00:00 KST 마감), 종료 후 허용/마감
- **동결**: 첫 체크나 첫 제출 시 `locked_at`을 기록합니다. 이후 할 일과 제출 필수 설정은 관리자도 바꿀 수 없고, 과제를 복사해 새 초안을 만들어야 합니다. 학생 수행과 강사 수정은 과제 행 잠금(`FOR UPDATE`)으로 순서가 정해집니다.
- **자동 완료**: 서버가 계산합니다(모든 할 일 체크 AND (제출 선택 OR 현재 제출물 1개 이상)). 기한 후 완료 여부는 완료 시점에 기록해 보존합니다.
- **제출물**: 버전 관리, 파일 확장자·매직바이트·크기 검증, 권한 검사 후 다운로드
- **피드백**: 학생별·과제별 작성, 버전 기반 읽음 표시, 수정·삭제 이력, 피드백 당시 제출 버전 참조
- **보안**: scrypt 해시, 서버 세션(취소 가능, 역할별 만료), CSRF 토큰, 로그인 시도 제한, 범위 밖 객체 404, 감사 이력, RLS로 PostgREST 차단

## 환경변수
`.env.example`을 참고하세요. 그 밖의 선택 설정은 다음과 같습니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `STUDENT_SESSION_MAX_H` / `_IDLE_H` | 168 / 24 | 학생 세션 |
| `STAFF_SESSION_MAX_H` / `_IDLE_H` | 12 / 2 | 운영자 세션 |
| `MAX_ATTACHMENT_MB` / `MAX_ROSTER_MB` / `MAX_ROSTER_ROWS` | 20 / 10 / 5000 | 파일 한도 |
| `LOGIN_MAX_FAILURES` | 10 | 15분당 로그인 실패 허용 횟수 |
| `SIGNED_URL_TTL_SEC` | 60 | 다운로드 서명 URL 유효 시간 |
| `ROSTER_API_TIMEOUT_MS` / `ROSTER_API_MAX_MB` | 15000 / 5 | 외부 명단 API 응답 시간·크기 제한 |
| `ROSTER_API_ALLOW_PRIVATE` | (없음) | `1`이면 http·내부망 주소 허용. 로컬 개발·테스트 전용이며 운영에서는 설정하지 마세요 |
| `PG_POOL_MAX` | 3 (Vercel) / 10 | DB 연결 풀 크기 |
| `COOKIE_SECURE`, `TRUST_PROXY` | Vercel에서 자동 `1` | 직접 호스팅 시 지정 |

## 알려진 제약
- 이메일 발송 연동이 없습니다. 강사 설정 링크는 관리자가 복사해서 전달합니다.
- 학생 비밀번호 해시는 대량 등록 속도를 위해 운영자보다 낮은 scrypt 비용(N=2^15)을 씁니다. 전화번호에서 파생된 값이라 원래 엔트로피가 낮습니다(PRD 5.3).
- 시각 컬럼은 UTC ISO 문자열(TEXT)로 저장합니다. 기간 판정은 서버가 KST 기준으로 계산합니다.
- 백업은 Supabase의 DB 백업 기능과 Storage 버킷을 함께 고려해야 합니다. Free 플랜에는 자동 백업 보존에 제한이 있습니다.
