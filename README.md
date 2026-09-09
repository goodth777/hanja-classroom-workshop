# 한자 교실 — 강의용 독립 설치

## 초보자 매뉴얼

저장소의 Code → Download ZIP으로 자료를 내려받고 압축을 해제한 뒤
`docs/workshop/beginner-start.html`을 브라우저에서 여세요.
전체 자료는 `docs/workshop/index.html`에 있습니다.
GitHub 파일 보기 화면에서는 HTML이 웹페이지로 실행되지 않습니다.

공개 전 검증 중인 강의용 사본입니다. 운영 저장소의 Git 이력, 학생 기록,
교사 개인 수업 자료 및 인증 정보는 포함하지 않습니다.

## 설치 구조

- GitHub: 이 저장소를 본인 계정으로 Fork합니다.
- Supabase: 새 프로젝트에 `setup/install-new-project.sql`을 실행합니다.
- Vercel: Root Directory를 **apps/web**으로 지정하고 외부 폴더 포함을 켭니다.
  `apps/web/vercel.json`이 설치·빌드 명령을 제공합니다.
- Render: `render.yaml` Blueprint를 사용합니다.
- 각자의 Supabase 주소·키, Vercel 웹 주소와 Render 서버 주소를 연결합니다.

환경 변수 예시는 `apps/web/.env.example`, `apps/server/.env.example`에 있습니다.
Secret/service_role 키는 Render 서버에만 넣습니다.
서버 주소가 누락되면 강사의 운영 서버로 연결되지 않습니다.

## 라이선스

직접 작성한 앱 코드는 MIT입니다. 한자 데이터와 아이콘 등 타사 자료의
별도 조건은 `THIRD_PARTY_NOTICES.md`와 `licenses/`를 확인하세요.
도깨비 영상의 배포 조건은 `MEDIA_LICENSE.md`를 확인하세요.

## 검증 상태

운영과 같은 경로 설정의 Vercel Preview 빌드는 통과했습니다.
2026-09-09 강의용 사본의 npm 보안 검사 0건, 타입 검사·린트·71개 테스트·전체 프로덕션 빌드를 통과했습니다.
수정 버전의 신규 계정 설치와 클라우드 게임 E2E 검증은 아직 수행하지 않았습니다.
아직 공개 배포 완료 또는 30명 무지연 운영을 보장하는 자료가 아닙니다.
