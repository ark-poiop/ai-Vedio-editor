# LLM Provider 및 숏폼 Orchestrator 계약

Shortform Studio의 LLM 기능은 deterministic 숏폼 후보를 대체하지 않고, 서버에서 후보의 의미 점수·순위·제목·요약·근거만 보강합니다. API 키와 Provider 주소는 브라우저, localStorage, 프로젝트 JSON에 저장하거나 반환하지 않습니다.

## 실행 모드

기본값은 `disabled`입니다. 이 상태에서도 기존 발화·장면·침묵 기반 후보 생성은 그대로 동작합니다.

```bash
npm run dev
```

외부 호출 없이 UI와 Orchestrator 흐름을 확인하려면 deterministic `mock` Provider를 사용합니다.

```bash
LLM_PROVIDER=mock npm run dev
```

### OpenAI-compatible Provider

`POST {baseUrl}/chat/completions`와 JSON object 응답 형식을 지원하는 Provider를 연결할 수 있습니다. 별도 SDK나 npm 패키지는 필요하지 않습니다.

```bash
LLM_PROVIDER=openai-compatible \
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_MODEL=replace-with-model-id \
LLM_API_KEY=replace-with-server-secret \
npm run dev
```

선택 설정:

```bash
# 1,000~120,000ms, 기본 30초
LLM_REQUEST_TIMEOUT_MS=30000

# 4KiB~1MiB, 기본 128KiB
LLM_MAX_RESPONSE_BYTES=131072
```

`LLM_BASE_URL`은 HTTPS만 허용하며 로컬 개발용 `localhost`, `127.0.0.1`, `[::1]`에 한해 HTTP를 허용합니다. URL의 자격 증명, query, fragment와 upstream redirect는 허용하지 않습니다. model, base URL, API key는 서버 시작 시 환경 변수에서만 읽으며 브라우저에서 변경할 수 없습니다.

## 로컬 API

### 상태 조회

```http
GET /api/llm/health
```

응답에는 공개 가능한 연결 상태만 포함합니다.

```json
{
  "status": "ok",
  "configured": true,
  "available": true,
  "provider": "openai-compatible",
  "model": "model-id",
  "demo": false,
  "features": ["shortform-rerank", "title", "summary", "reasons"]
}
```

API key와 base URL은 반환하지 않습니다. `disabled` 또는 잘못된 설정은 `available: false`로 표시됩니다.

### 숏폼 후보 재평가

```http
POST /api/llm/shortform/rerank
Content-Type: application/json
```

```json
{
  "language": "ko",
  "targetDuration": 30,
  "candidates": [
    {
      "id": "candidate-id",
      "score": 72,
      "start": 10.2,
      "end": 40.4,
      "title": "기본 후보 제목",
      "reasons": ["훅 문장", "자연스러운 경계"],
      "transcriptExcerpt": "후보에 포함된 제한 길이 발화 발췌"
    }
  ]
}
```

요청은 최대 6개 후보와 64KiB JSON으로 제한합니다. 브라우저는 후보별 transcript를 공백 정규화 후 최대 700자로 잘라 보내며 원본 미디어, 전체 프로젝트, API 자격 증명은 전송하지 않습니다. 서버는 후보 ID 중복, 점수, 시간 범위, 문자열 길이와 전체 발췌 크기를 다시 검증합니다.

성공 응답:

```json
{
  "provider": "openai-compatible",
  "model": "model-id",
  "demo": false,
  "candidates": [
    {
      "id": "candidate-id",
      "score": 79,
      "deterministicScore": 72,
      "semanticScore": 88,
      "title": "보강된 제목",
      "summary": "후보의 핵심을 설명하는 한 문장입니다.",
      "reasons": ["문제와 결론이 한 구간에서 완결됨"],
      "aiEnhanced": true,
      "rank": 1
    }
  ]
}
```

최종 점수는 서버에서 `deterministic 55% + semantic 45%`로 합성합니다. 시간 범위는 응답에 포함하지 않으며 LLM은 기존 candidate ID와 Timeline Patch 경계를 변경할 수 없습니다.

## OpenAI-compatible 응답 계약

Adapter는 Provider에 `response_format: { "type": "json_object" }`를 요청합니다. `choices[0].message.content`는 Markdown code fence가 아닌 엄격한 JSON 문자열이어야 합니다.

```json
{
  "candidates": [
    {
      "id": "요청에서 받은 ID",
      "semanticScore": 88,
      "title": "80자 이하 제목",
      "summary": "240자 이하 한 문장 요약",
      "reasons": ["80자 이하 근거, 1~4개"]
    }
  ]
}
```

모든 요청 candidate ID가 정확히 한 번씩 반환되어야 합니다. 알 수 없는 ID, 중복·누락 ID, 범위를 벗어난 점수, 빈 문자열, 너무 긴 필드 또는 후보 수 불일치는 전체 응답을 거부합니다.

## deterministic fallback과 취소

1. 브라우저가 자막/STT·장면·침묵 신호로 최대 6개 후보를 먼저 생성합니다.
2. 사용자가 `의미 기반 후보 보강`을 켰고 health가 available일 때만 LLM API를 호출합니다.
3. LLM 미설정, 네트워크 오류, timeout, 비정상 JSON, schema 불일치 또는 서버 과부하 시 deterministic 후보를 그대로 표시합니다.
4. 목표 길이 변경, 후보 취소·재생성, 타임라인·자막 변경 시 `AbortController`와 `analysisVersion`으로 진행 중 요청 및 stale 응답을 폐기합니다.
5. LLM 보강 결과도 자동 적용하지 않습니다. 사용자가 후보를 검토하고 선택한 뒤 기존 단일 `commit()`으로 적용하며 Undo로 복원할 수 있습니다.

브라우저의 semantic assist 선택만 `shortform-studio:llm-preference:v1`에 저장됩니다. Provider 자격 증명이나 모델 설정은 저장하지 않습니다.

## 제한, 오류 처리 및 배포

- 로컬 JSON 요청 본문은 기본 10초 안에 수신되어야 하며 client disconnect·서버 종료 시 body 수신도 즉시 중단합니다.
- Provider 요청 timeout은 response body 소비가 끝날 때까지 유지됩니다.
- upstream 응답은 기본 128KiB에서 중단하고 JSON Content-Type만 허용합니다.
- upstream redirect를 차단하고 오류 응답 본문, prompt, transcript, API key를 로컬 오류에 포함하지 않습니다.
- 서버 프로세스당 LLM 요청은 기본 동시 2개로 제한하며 초과 요청은 `429`입니다.
- 서버 종료와 클라이언트 연결 종료 시 active 요청을 abort합니다.
- 로컬 LLM API에는 아직 인증, 사용자별 소유권, rate limit, 비용 quota가 없습니다. 기본 loopback 개발 서버 용도이며 공유 배포 전 인증·rate limit·관측성·비용 한도와 TLS reverse proxy를 추가해야 합니다.
- transcript excerpt에는 사용자 콘텐츠가 포함됩니다. 실제 Provider의 데이터 처리·학습 사용·보관 기간·리전·삭제 정책을 검토하고 필요한 동의를 받아야 합니다.
- 프롬프트 공격 가능성을 전제로 LLM 출력은 신뢰하지 않으며, 서버와 브라우저 양쪽에서 schema를 검증합니다.
