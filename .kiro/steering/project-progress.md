---
inclusion: always
---

# Shortform Studio 프로젝트 진행 정보

## 저장소와 작업 방식
- GitHub 저장소: `ark-poiop/ai-Vedio-editor`
- 현재 개발 브랜치: `feat/shortform-studio-mvp`
- 앱은 외부 런타임 의존성이 없는 HTML/CSS/JavaScript 정적 웹 앱이다.
- npm 레지스트리가 샌드박스 정책으로 차단되어 있으므로 새 패키지를 추가하지 말고 Web API와 Node.js 기본 모듈을 우선 사용한다.
- 빌드 산출물인 `dist/`는 `.gitignore`에 포함하며 소스에서 재생성한다.

## 현재 구현
- 영상·이미지·오디오 업로드 및 IndexedDB 원본 보관
- 9:16, 1:1, 16:9 캔버스
- 미디어 프리뷰와 재생 제어
- 영상·텍스트·오디오 타임라인
- 클립 분할, 트림, 순서 변경, 삭제
- 텍스트 오버레이 속성 편집
- SRT/WebVTT 자막 가져오기, 타임라인 편집, UTF-8 SRT 내보내기
- 비동기 STT Job API와 mock/webhook Provider Adapter
- 자동 자막 업로드·진행률·취소·제안 검토·타임라인 승인 적용
- 선택 영상의 STT 제안 또는 타임라인 자막을 source-time에서 timeline-time으로 매핑하는 숏폼 신호 분석
- 최대 120개 저해상도 프레임의 색상 시그니처 장면 전환과 기존 침묵 경계를 결합한 15/30/45/60초 후보 생성
- 훅·발화 밀도·신뢰도·길이·경계·장면 변화 점수화와 시간·텍스트 유사도 기반 중복 억제
- 최대 6개 후보의 점수·근거 검토, 구간 미리보기, 9:16 Timeline Patch 적용과 Undo/Redo
- 원본 Blob 또는 장면 디코딩 실패 시 자막·타임라인 기반 graceful fallback
- 브라우저 `AudioContext.decodeAudioData()` + 25ms RMS 윈도우 기반 침묵 감지
- 침묵 임계값·최소 길이·음성 여백 설정과 후보별 선택·미리보기
- 선택한 침묵 구간을 모든 트랙·자막에 동기 적용하는 비파괴 글로벌 리플 삭제
- 브라우저 FaceDetector 또는 움직임·채도·경계 기반 시각 중심 자동 리프레임
- source-time 포커스 키프레임 검토·수동 가로 보정과 동일 asset 전체 클립 적용
- 포커스 보간을 반영한 9:16 프리뷰 및 WebM 렌더링
- 50단계 Undo/Redo
- localStorage 프로젝트 자동 저장과 JSON 다운로드
- 브라우저 기반 540p/1080p WebM 렌더링 및 오디오 믹싱
- Node.js 기본 모듈 + FFmpeg 기반 비동기 MP4 렌더 Job, raw 자산 업로드, 진행률 조회·취소·결과 다운로드
- FFmpeg `overlay`·`drawtext`·`amix`와 포커스 키프레임 crop을 이용한 서버 타임라인 합성
- 내보내기 모달 MP4/WebM 선택, FFmpeg capability 안내와 WebM 자동 fallback
- 독립 실행형 HTML과 강제 다운로드용 `.html.download` 빌드
- 아키텍처 및 28주 개발 계획 문서: `docs/ai-video-editor-development-plan.html`

## 주요 파일
- `src/app.js`: 편집기 상태, UI, 미디어 처리, 렌더링을 포함한 애플리케이션 로직
- `src/styles.css`: 편집기 전체 스타일
- `scripts/build.mjs`: 분리형 산출물과 독립 실행형 HTML 생성
- `scripts/serve.mjs`: 로컬 정적 서버, STT API, MP4 렌더 API 실행 진입점
- `server/app-server.mjs`: 정적 앱과 STT·렌더 API를 함께 제공하는 HTTP 서버
- `server/stt-service.mjs`: 비동기 STT Job, mock/webhook Provider, 결과 검증
- `server/render-service.mjs`: FFmpeg capability, 렌더 자산, 비동기 MP4 Job, 타임라인 filter graph
- `docs/stt-provider-contract.md`: STT Job 및 외부 Provider 연동 계약
- `sample-media.svg`: 업로드 검증용 샘플
- `sample-captions.srt`: 자막 워크플로우 검증용 샘플

## 검증 명령
```bash
npm run check
npm run build
```

브라우저 검증 시 확인할 핵심 흐름:
1. 앱 초기 렌더링
2. 미디어 업로드와 자동 타임라인 배치
3. 프리뷰 표시
4. 텍스트 또는 자막 편집
5. 자동 자막 Job 생성 → 제안 검토 → 승인 적용 → Undo
6. 침묵 분석 → 후보 선택·미리보기 → 글로벌 리플 삭제 → Undo
7. 자동 리프레임 분석 → 키프레임 미리보기·수동 보정 → 9:16 적용 → Undo/Redo
8. 숏폼 자동 후보 생성 → 점수·근거·접근성 상태 확인 → 구간 미리보기 → 9:16 적용 → Undo/Redo
9. 후보 검토 중 목표 길이 또는 클립·자막 시간 변경 → 재생 중지와 stale 후보 무효화
10. 원본 Blob 누락 프로젝트에서 자막 기반 fallback 및 자막 없는 프로젝트에서 목표 길이 visual fallback 확인
11. MP4 capability 확인 → 자산 업로드 → Job 진행률·취소 → 결과 다운로드
12. FFmpeg 미지원 환경에서 MP4 비활성 이유와 WebM fallback 확인
13. WebM 내보내기 완료

## 제품 및 아키텍처 원칙
- 비파괴 편집: 원본은 수정하지 않고 프로젝트 명령과 타임코드만 저장한다.
- AI 결과는 직접 확정하지 않고 사용자가 검토할 Timeline Patch 형태로 적용한다.
- 브라우저 WebM 렌더러는 로컬 fallback으로 유지하고, 상용 MP4 출력은 비동기 FFmpeg 서버 Job으로 분리한다.
- 자동 자막은 STT Provider, 의미 기반 숏폼 생성은 별도 LLM Provider를 AI Orchestrator 뒤에 연결한다.
- 첫 제품 목표는 긴 대화 영상에서 편집 가능한 세로형 숏폼을 만드는 것이다.

## 다음 개발 우선순위
1. 실제 상용 STT Provider 선택 및 webhook 연결
2. 의미 기반 후보 품질 고도화를 위한 별도 LLM Provider와 AI Orchestrator 연결
3. 렌더 Job 영속 저장소·큐·인증·보관 정책과 수평 확장
4. 리프레임 다중 피사체 전환·고급 추적과 분석 Worker 최적화
5. 침묵·장면 분석 파라미터 프리셋과 대용량 미디어용 Worker 최적화

## 알려진 제약
- 서버 MP4 렌더링에는 `ffmpeg`, `ffprobe`, `drawtext`, H.264 인코더가 필요하다. 현재 샌드박스에는 FFmpeg가 없고 네트워크 정책상 설치할 수 없어 실제 인코딩 E2E 대신 capability·API·filter graph·주입형 Job lifecycle을 검증했다.
- 렌더 자산과 Job 결과는 현재 서버 임시 디렉터리 및 메모리에 저장되어 프로세스 재시작 시 사라지며, 단일 노드 MVP 용도다.
- 렌더 Job은 프로세스당 동시 2개로 제한하지만 API 인증·사용자별 격리는 아직 없다. 공유 배포 전 인증, 소유권, 영속 큐와 보관 정책이 필요하다.
- 브라우저 WebM 렌더링은 영상 길이만큼 실시간 처리 시간이 필요하다.
- 샌드박스 Chromium에는 CJK 폰트가 없으므로 테스트 스크린샷에서 한글이 네모로 보일 수 있다. 앱에는 Noto Sans KR 웹폰트 폴백이 설정되어 있다.
- 기본 STT Provider는 UI/Job 흐름을 검증하는 mock이다. 실제 음성 인식은 `STT_PROVIDER=webhook`과 Provider URL/API 키 설정이 필요하다.
- 독립 실행형 `file://` HTML에서는 STT API를 사용할 수 없으며, 자동 자막은 `npm run dev`로 실행해야 한다.
- 침묵 감지는 브라우저가 디코딩할 수 있는 미디어 코덱에 한정되며 긴 영상은 현재 메인 스레드에서 분석한다.
- 자동 리프레임은 `FaceDetector` 지원 시 얼굴을 우선하고, 미지원 시 시각적 중심을 추정하므로 복잡한 다중 피사체 장면은 수동 키프레임 보정이 필요할 수 있다.
- 자동 리프레임과 침묵 분석은 현재 메인 스레드에서 실행되며 긴 영상용 Worker 이전이 후속 과제다.
- 숏폼 후보의 의미 품질은 현재 훅 키워드·발화 밀도·문장 경계·장면 변화의 deterministic 점수화에 기반한다. 실제 주제 이해·요약·브랜드 톤 최적화에는 별도 LLM Provider가 필요하다.
- 장면 전환 분석은 최대 120개 48×27 프레임의 4×3 RGB 시그니처를 사용하므로 빠른 컷이나 미세한 카메라 변화는 놓칠 수 있다. 원본 Blob·브라우저 코덱을 사용할 수 없으면 자막·타임라인 경계만으로 후보를 생성한다.
