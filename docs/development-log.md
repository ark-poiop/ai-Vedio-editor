# Shortform Studio — 개발 작업 내역

> 최종 업데이트: 2026-07-30

---

## 프로젝트 개요

긴 대화 영상에서 편집 가능한 세로형 숏폼 클립을 자동 생성하는 브라우저 기반 AI 비디오 편집기.  
외부 npm 의존성 없이 HTML/CSS/JavaScript + Node.js 기본 모듈로 구동.

- **저장소**: `ark-poiop/ai-Vedio-editor`
- **브랜치**: `feat/shortform-studio-mvp`
- **실행 환경**: macOS (Apple Silicon) + Docker Desktop
- **포트**: 앱 서버 2210, Whisper STT 서버 8787

---

## 아키텍처

```
┌─── macOS 호스트 ────────────────────────────────────────┐
│                                                          │
│  [Whisper 서버 :8787]  ← MLX Whisper Large v3 Turbo     │
│  [외부 LLM 서버]       ← OpenAI-compatible API          │
│                                                          │
│  ┌─── Docker Desktop ────────────────────────────────┐  │
│  │  [Shortform Studio :2210]                         │  │
│  │    ├── Node.js 22 앱 서버                          │  │
│  │    ├── FFmpeg (MP4 렌더링 + 오디오 추출)            │  │
│  │    ├── Noto CJK 한글 폰트                          │  │
│  │    └── STT/LLM/Render API                         │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 파일 구조

```
├── src/
│   ├── app.js              # 메인 앱 (3,600줄, IIFE + ES module import)
│   ├── state.js            # 상태 팩토리, 상수, 유틸리티
│   ├── styles.css          # 전체 UI 스타일 (CSS 변수 기반 타이포그래피)
│   └── silence-worker.js   # Web Worker (침묵 RMS 분석)
├── server/
│   ├── app-server.mjs      # HTTP 서버 (정적 + 모든 API 라우팅)
│   ├── stt-service.mjs     # STT Job 관리 (mock/assemblyai/whisper-local)
│   ├── whisper-provider.mjs # MLX Whisper 서버 연동 Provider
│   ├── assemblyai-provider.mjs # AssemblyAI 클라우드 STT
│   ├── llm-service.mjs     # LLM Provider (disabled/mock/openai-compatible)
│   └── render-service.mjs  # FFmpeg MP4 렌더 Job + 오디오 추출 API
├── whisper-server/
│   ├── server.py           # FastAPI MLX Whisper 서버
│   ├── requirements.txt    # Python 의존성
│   └── README.md
├── scripts/
│   ├── serve.mjs           # 개발 서버 진입점 (Whisper 자동 시작 포함)
│   └── build.mjs           # dist/ 빌드 (standalone HTML 포함)
├── tests/
│   └── server.test.mjs     # node:test 기반 서버 단위 테스트 (22개)
├── docs/                   # 문서
├── start.sh                # macOS 원클릭 실행 (Whisper + Docker)
├── stop.sh                 # 종료 스크립트
├── Dockerfile              # Node 22 + FFmpeg + Noto CJK
├── docker-compose.yml      # 포트 2210, env_file, tmpfs
├── .env.example            # 환경변수 예시 (macOS 기본값)
└── .github/workflows/ci.yml # CI: check + test + build
```

---

## 2026-07-30 작업 내역 (시간순)

### Phase 1: 기초 개선 (8단계)

| # | 작업 | 커밋 |
|---|------|------|
| 1 | CSS 타이포그래피 스케일 정상화 (6px→11px 최소) | `bd0bd19` |
| 2 | README.md 작성 | `4539a21` |
| 3 | 키보드 단축키 (Ctrl+Y, 방향키, J/K/L, Home/End) | `67e4082` |
| 4 | GitHub Actions CI (check + test + build) | `335015d` |
| 5 | WebM 내보내기 취소 + Inspector 아코디언 UI | `1ca8fce` |
| 6 | app.js → state.js 모듈 분리 (ES module) | `637f3c8` |
| 7 | 서버 단위 테스트 22개 (node:test) | `9e368f5` |
| 8 | 침묵 분석 Web Worker 이전 | `2aca649` |

### Phase 2: 핵심 편집 기능

| # | 작업 | 커밋 |
|---|------|------|
| 1 | 클립 복제 (Ctrl+D) | `d401897` |
| 2 | 멀티 선택 (Shift+Click, Ctrl+Click) | `6dd67ed` |
| 3 | 속도 조절 (0.25x–4x), clipDuration/clipSourceTime 헬퍼 | `4812995` |
| 4 | 글꼴 선택 (6개 프리셋, Canvas drawText 반영) | `08e4ae8` |
| 5 | 키프레임 애니메이션 (x/y/fontSize/opacity 보간) | `c6c6e87` |
| 6 | 오디오 페이드 인/아웃 (선형 envelope) | `3d33c9d` |
| 7 | 화면 전환 효과 (fade/dissolve/wipe) | `9a1e9e1` |

### Phase 3: LLM/STT 통합

| # | 작업 | 커밋 |
|---|------|------|
| 1 | 외부 HTTP/HTTPS URL 허용 (LLM Provider) | `774a6e9` |
| 2 | LLM 보강 실패 시 상세 에러 메시지 | `7347556` |
| 3 | MLX Whisper 서버 + whisper-provider + 자동 시작 | `d8a7e9b`, `7940abe` |

### Phase 4: UX 피드백 반영

| # | 작업 | 커밋 |
|---|------|------|
| 1 | 타임라인 오디오 파형 시각화 (SVG, 서버 fallback) | `11bfdc7` |
| 2 | 침묵 분석 서버 FFmpeg 오디오 추출 fallback (MOV 지원) | `1edaace`, `795f10b` |
| 3 | 텍스트 최소 글자 크기 12px, 글상자 폭 조절 | `f7e419c` |
| 4 | 슬라이더 ↔ 숫자 입력 연동 (fontSize, opacity, boxWidth) | `bce0c5d` |
| 5 | 침묵 리플 삭제 후 클립 간 gap 스냅 | `eca0409`, `81bb047` |

### Phase 5: MP4 내보내기 깜빡임 해결

| # | 작업 | 커밋 |
|---|------|------|
| 1 | overlay → **concat** 방식으로 전환 (근본 해결) | `e4ecd37` |
| 2 | Noto CJK fontfile로 한글 자막 인코딩 수정 | `9364399` |

### Phase 6: 타임라인 고급 기능

| # | 작업 | 커밋 |
|---|------|------|
| 1 | 드래그 범위 선택 (rubber-band) | `e5c4f4e` |
| 2 | 클립 위치 드래그 이동 (timelineStart) | `e5c4f4e` |
| 3 | 동적 트랙 추가/삭제 (V2, T2, A2...) | `e5c4f4e`, `64547cc` |
| 4 | 드래그로 트랙 간 이동 | `08e4bad` |
| 5 | Inspector 트랙 변경 드롭다운 | `4bcacf3` |
| 6 | 오디오 분리 (영상→오디오 트랙) + 뮤트 표시 | `4273b4c`, `ce57077` |
| 7 | 자막/텍스트 프리뷰 드래그 이동 | `6846592` |
| 8 | Ctrl+A 전체 선택 | `0a4d591` |

### Phase 7: 안정화 및 macOS 통합

| # | 작업 | 커밋 |
|---|------|------|
| 1 | start.sh / stop.sh (Whisper + Docker 원클릭) | `696a77a` |
| 2 | 새 프로젝트 + 프로젝트 목록 저장 | `696a77a` |
| 3 | JSON 프로젝트 Import | `696a77a` |
| 4 | beforeunload 미저장 경고 | `696a77a` |
| 5 | localStorage quota 방어 | `696a77a` |
| 6 | .env.example macOS 기본값 | `696a77a` |
| 7 | 버튼 가시성 수정 (.small-action, > selector) | `20166fc` |
| 8 | Docker env_file 명시 | `368a45a` |

---

## 핵심 설계 결정

### 비파괴 편집
원본 미디어는 IndexedDB에 보관. 프로젝트는 타임코드와 속성만 저장.

### AI는 제안, 사용자가 확정
STT 결과 → 제안 검토 → 승인 적용. LLM 숏폼 후보 → 사용자 선택 → Timeline Patch.

### Graceful Degradation
- LLM 장애 → deterministic 점수 기반 후보 유지
- STT 장애 → 수동 SRT 가져오기
- FFmpeg 없음 → WebM 브라우저 렌더

### concat 기반 MP4 렌더링
overlay + enable 방식은 키프레임 디코딩 지연으로 깜빡임 발생.
concat 필터로 미리 준비된 세그먼트를 이어 붙여 gap 없는 컷 편집 보장.

### 속도 계산 공식
```
timelineDuration = (sourceEnd - sourceStart) / speed
sourceTime = sourceStart + (playhead - timelineStart) * speed
```

---

## 알려진 제약 및 미해결 이슈

### 미해결
- **WebM 내보내기 깜빡임**: 브라우저 실시간 렌더 + video seek 지연. MP4 사용 권장.
- **app.js 3,600줄**: 추가 모듈 분리 필요 (렌더링/미디어/AI).
- **인증 없음**: 로컬 단일 사용자 전용.

### macOS 제약
- Whisper 서버는 MLX (Apple Silicon 전용)이라 Docker에 통합 불가.
- `start.sh`로 호스트에서 별도 실행 필요.

### 브라우저 제약
- 침묵 분석: MOV/HEVC는 `decodeAudioData` 실패 → 서버 FFmpeg fallback으로 해결.
- `file://` 프로토콜에서는 STT/LLM/렌더 API 사용 불가.
- 시스템 폰트 목록 접근 불가 (보안 정책) → 프리셋만 제공.

---

## 실행 방법

### macOS (권장)
```bash
# 최초 1회: Whisper 설치
cd whisper-server && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cd ..

# .env 설정
cp .env.example .env
# .env에서 LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY 설정

# 실행 (Whisper + Docker 동시)
./start.sh

# 종료
./stop.sh
```

### Docker만 (STT 없이)
```bash
docker compose up -d --build
# http://localhost:2210
```

---

## 테스트
```bash
npm run check   # 모든 소스 문법 검증
npm run test    # 서버 단위 테스트 22개
npm run build   # dist/ 산출물 생성
```

---

## 향후 고려 사항

- TTS 통합 (Coqui XTTS 권장 — MPL 2.0, 음성 클론, 한국어)
- 영상 필터 (밝기/대비/채도/흑백)
- 에셋 라이브러리 (스티커/도형/효과음)
- Ken Burns 효과 (영상 줌/패닝 키프레임)
- 프로젝트 목록 UI 화면
- Playwright E2E 테스트
- 수평 확장 (인증, Job 큐, S3 저장소)
