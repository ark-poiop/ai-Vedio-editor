# STT Provider 계약

Shortform Studio의 자동 자막은 브라우저가 로컬 앱 서버에 Job을 만들고, 서버의 Provider Adapter가 실제 STT 서비스와 통신하는 구조입니다. API 키는 브라우저에 노출하지 않습니다.

## 실행 모드

기본값은 외부 서비스 없이 흐름을 검증하는 `mock` Provider입니다.

```bash
npm run dev
```

실제 Provider는 다음 환경 변수로 연결합니다.

```bash
STT_PROVIDER=webhook \
STT_PROVIDER_URL=https://stt.example.com/transcribe \
STT_PROVIDER_API_KEY=replace-me \
npm run dev
```

## 편집기 → 로컬 Job API

### Job 생성

```http
POST /api/stt/jobs
Content-Type: audio/wav
X-File-Name: interview.wav
X-Asset-Id: asset-uuid
X-Asset-Duration: 62.4
X-Language: ko

<binary media body>
```

응답은 HTTP `202`입니다.

```json
{
  "id": "job-uuid",
  "status": "queued",
  "progress": 0,
  "provider": "mock",
  "demo": true
}
```

### Job 조회 및 취소

```http
GET /api/stt/jobs/{jobId}
DELETE /api/stt/jobs/{jobId}
```

상태는 `queued`, `processing`, `completed`, `failed`, `cancelled` 중 하나입니다.

## 로컬 서버 → Webhook Provider

Webhook에는 원본 바이너리와 동일한 메타데이터 헤더를 전달합니다. API 키가 설정되면 `Authorization: Bearer ...` 헤더를 추가합니다.

Webhook은 다음 JSON을 반환해야 합니다.

```json
{
  "language": "ko",
  "segments": [
    {
      "start": 0.42,
      "end": 3.85,
      "text": "첫 번째 인식 문장입니다.",
      "confidence": 0.96,
      "speaker": "speaker-1"
    }
  ]
}
```

필수 필드는 `segments[].start`, `segments[].end`, `segments[].text`입니다. 서버가 잘못된 구간을 제거하고 시간순으로 정렬합니다.

## 적용 원칙

STT 완료 결과는 프로젝트에 즉시 반영하지 않습니다.

1. Job 완료
2. 자막 제안 목록 표시
3. 사용자가 결과 검토
4. `타임라인에 적용` 승인
5. 원본 클립의 source time을 timeline time으로 변환
6. 한 번의 Undo로 전체 적용 복구

독립 실행형 `file://` HTML에서는 API를 호출할 수 없으므로 수동 SRT/VTT 기능만 사용할 수 있습니다. 자동 자막은 `npm run dev`로 실행해야 합니다.
