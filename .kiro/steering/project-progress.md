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
- 50단계 Undo/Redo
- localStorage 프로젝트 자동 저장과 JSON 다운로드
- 브라우저 기반 540p/1080p WebM 렌더링 및 오디오 믹싱
- 독립 실행형 HTML과 강제 다운로드용 `.html.download` 빌드
- 아키텍처 및 28주 개발 계획 문서: `docs/ai-video-editor-development-plan.html`

## 주요 파일
- `src/app.js`: 편집기 상태, UI, 미디어 처리, 렌더링을 포함한 애플리케이션 로직
- `src/styles.css`: 편집기 전체 스타일
- `scripts/build.mjs`: 분리형 산출물과 독립 실행형 HTML 생성
- `scripts/serve.mjs`: 로컬 정적 서버 및 STT API 실행 진입점
- `server/app-server.mjs`: 정적 앱과 STT API를 함께 제공하는 HTTP 서버
- `server/stt-service.mjs`: 비동기 STT Job, mock/webhook Provider, 결과 검증
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
6. WebM 내보내기 완료

## 제품 및 아키텍처 원칙
- 비파괴 편집: 원본은 수정하지 않고 프로젝트 명령과 타임코드만 저장한다.
- AI 결과는 직접 확정하지 않고 사용자가 검토할 Timeline Patch 형태로 적용한다.
- 현재 브라우저 렌더러는 MVP이며 상용 MP4 출력은 후속 FFmpeg 서버 렌더러로 분리한다.
- 자동 자막은 STT Provider, 의미 기반 숏폼 생성은 별도 LLM Provider를 AI Orchestrator 뒤에 연결한다.
- 첫 제품 목표는 긴 대화 영상에서 편집 가능한 세로형 숏폼을 만드는 것이다.

## 다음 개발 우선순위
1. 침묵 구간 감지 및 삭제 후보 미리보기
2. 세로 자동 리프레임
3. 서버 기반 MP4 렌더링
4. 긴 영상에서 숏폼 후보 자동 생성
5. 실제 상용 STT Provider 선택 및 webhook 연결

## 알려진 제약
- 브라우저 WebM 렌더링은 영상 길이만큼 실시간 처리 시간이 필요하다.
- 샌드박스 Chromium에는 CJK 폰트가 없으므로 테스트 스크린샷에서 한글이 네모로 보일 수 있다. 앱에는 Noto Sans KR 웹폰트 폴백이 설정되어 있다.
- 기본 STT Provider는 UI/Job 흐름을 검증하는 mock이다. 실제 음성 인식은 `STT_PROVIDER=webhook`과 Provider URL/API 키 설정이 필요하다.
- 독립 실행형 `file://` HTML에서는 STT API를 사용할 수 없으며, 자동 자막은 `npm run dev`로 실행해야 한다.
- 침묵 감지·리프레임은 아직 분석 서비스와 연결되지 않았다.
