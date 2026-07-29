# Docker 실행 및 설정

Shortform Studio는 npm 패키지 설치 없이 Node.js 기본 모듈로 실행됩니다. Docker 이미지는 Node.js 22, FFmpeg, 한국어 자막용 Noto CJK 글꼴을 포함하며 기본 포트는 `2210`입니다.

## 빠른 실행

```bash
docker compose up --build -d
```

브라우저에서 `http://localhost:2210`에 접속합니다.

상태 확인과 종료:

```bash
docker compose ps
docker compose logs -f shortform-studio
docker compose down
```

Compose를 사용하지 않는 경우:

```bash
docker build -t shortform-studio .
docker run --rm -p 127.0.0.1:2210:2210 shortform-studio
```

컨테이너는 내부에서 `HOST=0.0.0.0`, `PORT=2210`으로 실행되지만 Compose와 위 `docker run` 예시는 호스트의 `127.0.0.1:2210`에만 게시합니다. 외부 접속이 필요하면 인증·TLS·rate limit이 있는 reverse proxy를 사용하세요. `/tmp`는 FFmpeg 렌더 자산과 결과를 위한 임시 저장소이며 Compose에서는 기본 8GiB tmpfs로 제한합니다. 긴 원본이나 동시 렌더가 많다면 `.env`의 `SHORTFORM_TMPFS_SIZE`를 조정하세요. 컨테이너 재시작 시 Job과 임시 결과는 사라집니다.

## AI Provider 설정

`.env.example`을 `.env`로 복사하고 필요한 서버 환경변수만 채웁니다.

```bash
cp .env.example .env
```

### 데모 LLM

외부 API 없이 의미 보강 UI를 확인할 수 있습니다.

```dotenv
LLM_PROVIDER=mock
```

### OpenAI-compatible LLM

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=replace-with-model-id
LLM_API_KEY=replace-with-server-secret
```

### AssemblyAI STT

```dotenv
STT_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=replace-with-server-secret
ASSEMBLYAI_SPEAKER_LABELS=true
```

설정 변경 후 컨테이너를 다시 생성합니다.

```bash
docker compose up -d --build --force-recreate
```

## 앱 설정 메뉴

상단의 `설정` 버튼에서는 다음 비밀이 아닌 사용자 설정을 변경할 수 있습니다.

- 미디어·속성 패널 폭과 타임라인 높이
- 균형, 프리뷰 집중, 타임라인 집중 레이아웃
- 각 패널 표시 여부
- Safe Zone, 컴팩트 도구 모음, 모션 줄이기
- 자동 자막 기본 언어
- 숏폼 LLM 의미 보강 사용 여부
- LLM, STT, FFmpeg 서버 연결 상태
- LLM 서버 환경변수 설정 위치, 현재 미설정 원인, 복사 가능한 `.env` 예시

레이아웃은 패널 경계의 resize handle을 마우스·펜으로 드래그하거나 키보드 방향키로 조절할 수 있습니다. 설정은 브라우저의 `shortform-studio:ui-preference:v1`에 저장되고 프로젝트 JSON에는 섞이지 않습니다.

API 키, Provider URL, 모델 ID는 브라우저 설정이나 localStorage에 저장하지 않습니다. 설정 화면의 **LLM 정보는 어디에 입력하나요?** 안내에서 `.env` 예시를 복사할 수 있지만 실제 값은 반드시 Docker `.env` 또는 배포 플랫폼의 secret 환경변수로 입력해야 합니다. 서버 환경변수는 실행 중인 프로세스에서 안전하게 변경할 수 없으므로 적용하려면 컨테이너를 다시 생성해야 합니다. 설정 메뉴에는 공개 가능한 Provider 상태와 model 이름, 미설정 원인만 표시됩니다.

## 보안과 운영 제한

- `.env`는 Git에서 제외되며 `.env.example`에는 실제 키를 넣지 않습니다.
- 기본 API에는 사용자 인증·rate limit·소유권 분리가 없습니다. 인터넷에 직접 노출하지 말고 인증과 TLS가 있는 reverse proxy 뒤에서 운영하세요.
- Compose는 포트를 기본적으로 호스트 loopback(`127.0.0.1:2210`)에만 게시하고, read-only root filesystem과 `no-new-privileges`를 사용합니다.
- 외부 LLM에는 후보별 제한 길이 transcript excerpt만 전송되지만 사용자 콘텐츠이므로 Provider 데이터 처리 정책을 확인해야 합니다.
- 실제 운영에서는 Job 영속 저장소, 사용자별 quota, 비용 모니터링과 보관 정책이 추가로 필요합니다.
