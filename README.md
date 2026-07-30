# Shortform Studio

긴 대화 영상에서 편집 가능한 **세로형 숏폼 클립**을 자동 생성하는 브라우저 기반 AI 비디오 편집기.

> 외부 런타임 의존성 없이 HTML/CSS/JavaScript만으로 동작하며, AI 기능(STT·LLM)은 서버 Provider를 통해 선택적으로 연결합니다.

---

## 주요 기능

| 카테고리 | 기능 |
|----------|------|
| **편집** | 비파괴 타임라인 편집, 클립 분할/트림/순서 변경, 50단계 Undo/Redo |
| **캔버스** | 9:16 (Shorts), 1:1 (Instagram), 16:9 (YouTube) |
| **자막** | SRT/WebVTT 가져오기, 타임라인 편집, UTF-8 SRT 내보내기 |
| **자동 자막** | STT Provider (mock/AssemblyAI/webhook) 기반 비동기 생성 |
| **침묵 제거** | 브라우저 AudioContext RMS 분석 → 글로벌 리플 삭제 |
| **자동 리프레임** | FaceDetector 또는 시각 중심 기반 9:16 포커스 키프레임 |
| **숏폼 생성** | 장면 전환 + 침묵 경계 + 훅·발화 밀도 점수화 → AI 의미 보강(선택) |
| **내보내기** | 브라우저 WebM (540p/1080p) + 서버 FFmpeg MP4 |
| **UI** | 드래그 패널 리사이즈, 3개 레이아웃 프리셋, 다크 테마, 한국어 지원 |

---

## 빠른 시작

```bash
git clone https://github.com/ark-poiop/ai-Vedio-editor.git
cd ai-Vedio-editor
npm run dev
# → http://localhost:2210 에서 편집기 실행
```

**요구 사항:** Node.js 22+

---

## Docker 실행

```bash
cp .env.example .env
# .env에서 필요한 Provider 설정 수정
docker compose up -d
# → http://localhost:2210
```

Docker 이미지에는 FFmpeg, Noto CJK 글꼴이 포함되어 MP4 내보내기와 한국어 표시가 바로 작동합니다.

로컬 LLM (Ollama/LM Studio) 연결은 `.env`에서:
```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=qwen2.5:7b
```

---

## 프로젝트 구조

```
├── src/
│   ├── app.js          # 편집기 애플리케이션 로직
│   └── styles.css      # UI 스타일
├── server/
│   ├── app-server.mjs  # HTTP 서버 (정적 + API)
│   ├── stt-service.mjs # STT Job 관리
│   ├── assemblyai-provider.mjs  # AssemblyAI adapter
│   ├── llm-service.mjs # LLM Provider + 숏폼 rerank API
│   └── render-service.mjs       # FFmpeg MP4 렌더 Job
├── scripts/
│   ├── serve.mjs       # 개발 서버 진입점 (포트 2210)
│   └── build.mjs       # 독립 실행형 HTML 빌드
├── docs/               # Provider 계약·배포 문서
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev` | 개발 서버 (포트 2210, STT/LLM/렌더 API 포함) |
| `npm run build` | `dist/` 산출물 생성 (독립 실행형 HTML + 강제 다운로드용) |
| `npm run check` | 모든 소스 파일 문법 검증 |

---

## AI Provider 설정

### STT (자동 자막)

| 환경변수 | 값 | 설명 |
|----------|-----|------|
| `STT_PROVIDER` | `mock` | 개발용 모의 응답 (기본값) |
| | `assemblyai` | AssemblyAI 실제 API |
| | `webhook` | 외부 webhook 연동 |
| `ASSEMBLYAI_API_KEY` | | AssemblyAI 사용 시 필수 |

### LLM (숏폼 의미 보강)

| 환경변수 | 값 | 설명 |
|----------|-----|------|
| `LLM_PROVIDER` | `disabled` | AI 보강 비활성 (기본값) |
| | `mock` | 개발용 모의 응답 |
| | `openai-compatible` | OpenAI/Ollama/LM Studio/vLLM |
| `LLM_BASE_URL` | | API 엔드포인트 URL |
| `LLM_MODEL` | | 사용할 모델명 |
| `LLM_API_KEY` | | API 키 (로컬 LLM은 아무 값) |

> LLM이 비활성이거나 장애 시에도 deterministic 점수 기반 숏폼 후보가 항상 제공됩니다.

---

## 설계 원칙

- **비파괴 편집** — 원본은 수정하지 않고 타임코드만 저장
- **AI는 제안, 사용자가 확정** — Timeline Patch 형태로 검토 후 적용
- **Graceful Degradation** — 모든 AI Provider 장애 시 독립 동작
- **제로 외부 의존성** — Web API + Node.js 기본 모듈만 사용
- **보안 기본기** — path traversal 방어, FFmpeg 주입 방어, secret 서버 전용

---

## 문서

- [STT Provider 계약](docs/stt-provider-contract.md)
- [LLM Provider 계약](docs/llm-provider-contract.md)
- [Docker 배포 가이드](docs/docker-deployment.md)
- [개발 계획 (28주 로드맵)](docs/ai-video-editor-development-plan.html)

---

## 알려진 제약

- 브라우저 WebM 렌더링은 영상 길이만큼 실시간 처리 시간 필요
- MP4 내보내기에는 서버 측 FFmpeg가 필요 (Docker 사용 권장)
- 침묵/리프레임 분석은 현재 메인 스레드에서 실행 (Worker 이전 예정)
- 인증·사용자별 격리 없음 — 현재 로컬/단일 사용자 용도
- `file://` 독립 실행형 HTML에서는 STT/LLM API 사용 불가

---

## 라이선스

Private — 비공개 프로젝트
