# Docker Desktop 실행 및 설정

Shortform Studio는 npm 설치나 `npm run dev` 없이 Docker Desktop만으로 실행할 수 있습니다. Docker 이미지는 Node.js 22, FFmpeg, 한국어 UI·자막용 Noto CJK 글꼴을 포함하며 기본 포트는 `2210`입니다. 포함된 Noto CJK 글꼴은 앱이 웹폰트로 직접 제공하므로 Google Fonts 연결이 차단되어도 한국어 UI가 깨지지 않습니다.

## Docker Desktop로 시작

1. Docker Desktop을 실행하고 Engine이 준비될 때까지 기다립니다.
2. 저장소 루트에서 `.env.example`을 `.env`로 복사합니다.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

3. 아래 명령으로 Docker Desktop에 Compose 앱을 생성합니다.

```bash
docker compose up --build -d
```

최초 생성 후에는 Docker Desktop의 **Containers** 화면에서 `shortform-studio` 앱을 시작·중지·재시작할 수 있습니다. 소스나 `.env`를 바꿨다면 다음 명령으로 이미지를 다시 만들고 컨테이너를 교체하세요.

```bash
docker compose up -d --build --force-recreate
```

브라우저에서 `http://localhost:2210`에 접속합니다. 이 흐름에서는 호스트 Node.js, npm 또는 `node_modules`가 필요하지 않습니다.

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

### Docker Desktop에서 호스트 로컬 LLM 사용

Docker 컨테이너의 `localhost`는 PC가 아니라 컨테이너 자신입니다. Ollama, LM Studio, vLLM처럼 PC에서 실행 중인 OpenAI-compatible 서버에는 Compose가 제공하는 `host.docker.internal` 주소로 연결합니다.

Ollama 기본 포트 예시:

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=qwen2.5:7b
LLM_API_KEY=local-only
```

LM Studio 기본 포트 예시:

```dotenv
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://host.docker.internal:1234/v1
LLM_MODEL=LM-Studio에-표시된-model-id
LLM_API_KEY=local-only
```

`LLM_API_KEY`는 현재 설정 검증상 비어 있으면 안 됩니다. 인증을 요구하지 않는 로컬 서버에는 `local-only`처럼 외부에서 의미 없는 값을 사용하세요. 로컬 LLM 서버가 `/v1/chat/completions`를 지원하고 Docker Desktop 연결을 허용해야 합니다. Ollama/LM Studio가 다른 PC에서의 접속을 차단한다면 해당 앱에서 네트워크 제공 옵션을 켜야 할 수 있습니다.

연결 설정 확인:

```bash
curl http://localhost:2210/api/llm/health
```

응답의 `provider`가 `openai-compatible`, `model`이 지정한 모델이고 `configured`가 `true`이면 `.env`가 컨테이너에 적용된 것입니다.

또는 앱의 **설정 → AI 도움 → 로컬 LLM 연결**에서 Ollama/LM Studio preset을 선택하고 model ID를 입력한 뒤 다음 중 하나를 실행할 수 있습니다.

- **연결 테스트**: 실제 `/chat/completions`와 앱이 요구하는 JSON 응답 호환성을 확인하며 현재 설정은 바꾸지 않습니다.
- **테스트 후 적용**: 같은 테스트가 성공한 경우에만 현재 서버 Provider를 즉시 교체합니다.
- **API Key**: 로컬 서버가 인증을 요구할 때만 입력합니다. 인증이 없으면 비워 둡니다. 입력값은 localStorage·프로젝트 JSON·서버 응답·로그에 저장되지 않고 적용 성공 또는 설정창 종료 시 브라우저 메모리에서도 제거됩니다.

웹에서 적용한 URL, model ID와 API key는 파일에 기록하지 않고 서버 메모리에만 유지합니다. 컨테이너를 재시작하면 `.env` 값으로 복원되므로 영구 설정은 `.env`에 기록하세요.

### 클라우드 OpenAI-compatible LLM

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
- 로컬 LLM Base URL·model ID 입력, Ollama/LM Studio preset, 실제 연결 테스트와 런타임 적용
- LLM 서버 환경변수 설정 위치, 현재 미설정 원인, 복사 가능한 `.env` 예시

레이아웃은 패널 경계의 resize handle을 마우스·펜으로 드래그하거나 키보드 방향키로 조절할 수 있습니다. 설정은 브라우저의 `shortform-studio:ui-preference:v1`에 저장되고 프로젝트 JSON에는 섞이지 않습니다.

API key는 웹 설정에서 세션 전용으로 입력할 수 있지만 localStorage나 프로젝트 JSON에 저장하지 않습니다. 로컬 LLM의 Base URL·model ID·API key는 설정 화면에서 테스트·임시 적용할 수 있으며, key는 적용 성공 또는 설정창 종료 시 브라우저 메모리에서도 제거됩니다. 컨테이너 재시작 후에도 유지할 영구 설정과 클라우드 Provider 자격 증명은 Docker `.env` 또는 배포 플랫폼의 secret 환경변수로 관리하세요. 설정 메뉴에는 공개 가능한 Provider 상태와 model 이름, 미설정 원인만 표시됩니다.

## 보안과 운영 제한

- `.env`는 Git에서 제외되며 `.env.example`에는 실제 키를 넣지 않습니다.
- 기본 API에는 사용자 인증·rate limit·소유권 분리가 없습니다. 인터넷에 직접 노출하지 말고 인증과 TLS가 있는 reverse proxy 뒤에서 운영하세요.
- Compose는 포트를 기본적으로 호스트 loopback(`127.0.0.1:2210`)에만 게시하고, read-only root filesystem과 `no-new-privileges`를 사용합니다.
- 외부 LLM에는 후보별 제한 길이 transcript excerpt만 전송되지만 사용자 콘텐츠이므로 Provider 데이터 처리 정책을 확인해야 합니다.
- 실제 운영에서는 Job 영속 저장소, 사용자별 quota, 비용 모니터링과 보관 정책이 추가로 필요합니다.
