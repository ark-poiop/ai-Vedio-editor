# STT Provider 계약

Shortform Studio의 자동 자막은 브라우저가 로컬 앱 서버에 Job을 만들고, 서버의 Provider Adapter가 실제 STT 서비스와 통신하는 구조입니다. API 키는 브라우저와 프로젝트 JSON에 노출하지 않습니다.

## 실행 모드

기본값은 외부 서비스 없이 흐름을 검증하는 `mock` Provider입니다.

```bash
npm run dev
```

### AssemblyAI

한국어 배치 전사와 화자 분리가 필요한 실제 환경에서는 내장 AssemblyAI Adapter를 사용할 수 있습니다. 별도 SDK나 npm 패키지는 필요하지 않습니다.

```bash
STT_PROVIDER=assemblyai \
ASSEMBLYAI_API_KEY=replace-me \
npm run dev
```

Adapter는 다음 순서로 동작합니다.

1. `POST https://api.assemblyai.com/v2/upload`로 원본 미디어 업로드
2. `POST /v2/transcript`로 비동기 전사 생성
3. `GET /v2/transcript/{id}`를 `queued`/`processing` 동안 polling
4. `utterances`를 화자별 canonical segment로 정규화
5. 완료 결과를 로컬 Job에 복사한 뒤 원격 transcript 삭제
6. 로컬 Job 취소·실패 또는 서버 종료 시에도 `DELETE /v2/transcript/{id}` 요청

현재 기본 모델 우선순위는 한국어를 포함한 넓은 언어 범위를 위해 `universal-3-pro,universal-2`입니다. AssemblyAI는 전사 요청에 `speech_models`가 필요하며, 앞 모델이 해당 언어를 지원하지 않으면 다음 모델로 fallback합니다.

선택 설정:

```bash
# 기본값: universal-3-pro,universal-2
ASSEMBLYAI_SPEECH_MODELS=universal-3-pro,universal-2

# 기본값: true. false로 설정하면 화자 분리를 끕니다.
ASSEMBLYAI_SPEAKER_LABELS=true

# 단일 일반 요청 45초, 업로드 10분, 전체 전사 2시간, 최초 polling 1.2초
ASSEMBLYAI_REQUEST_TIMEOUT_MS=45000
ASSEMBLYAI_UPLOAD_TIMEOUT_MS=600000
ASSEMBLYAI_TRANSCRIPT_TIMEOUT_MS=7200000
ASSEMBLYAI_POLL_INTERVAL_MS=1200
```

`ASSEMBLYAI_API_KEY` 대신 기존 공통 변수인 `STT_PROVIDER_API_KEY`도 사용할 수 있지만, Provider별 키 이름 사용을 권장합니다.

공식 참고 자료:
- [AssemblyAI pre-recorded transcription guide](https://assemblyai.com/docs/Guides/transcribing_an_audio_file)
- [AssemblyAI Korean speech-to-text](https://www.assemblyai.com/languages/korean)
- [AssemblyAI pre-recorded speech-to-text models](https://www.assemblyai.com/products/speech-to-text)

### Generic Webhook

자체 STT 게이트웨이를 사용하는 경우 기존 webhook Adapter를 유지합니다.

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
  "message": "STT 작업을 준비하고 있습니다.",
  "provider": "assemblyai",
  "demo": false
}
```

### Job 조회 및 취소

```http
GET /api/stt/jobs/{jobId}
DELETE /api/stt/jobs/{jobId}
```

상태는 `queued`, `processing`, `completed`, `failed`, `cancelled` 중 하나입니다. AssemblyAI Adapter는 업로드·전사·결과 정리 단계를 로컬 `progress`와 `message`로 전달합니다.

## 로컬 서버 → Generic Webhook Provider

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

필수 필드는 `segments[].start`, `segments[].end`, `segments[].text`입니다. 서버는 잘못된 구간을 제거하고, confidence를 0~1로 제한하고, 시간순으로 정렬합니다.

## 제한과 오류 처리

- 로컬 업로드는 기본 250 MiB, 미디어 길이는 최대 24시간입니다.
- Provider 결과는 최대 20,000개 segment, 단일 텍스트 4,000자, 전체 UTF-8 텍스트 4 MiB로 제한합니다.
- AssemblyAI JSON 응답은 기본 8 MiB에서 중단합니다.
- upload `422`, `429`, 일시적 `5xx`와 polling GET의 `429`·일시적 `5xx`는 bounded exponential backoff로 재시도합니다.
- 과금 가능한 transcript 생성 POST는 응답 유실 시 중복 생성을 피하기 위해 자동 재시도하지 않습니다.
- `Retry-After`는 전체 deadline 안에서 Provider가 지정한 시간을 그대로 기다리며, 남은 시간을 넘으면 조기 재요청하지 않고 실패합니다.
- upstream 응답 본문, transcript 내용, API 키는 로컬 오류 메시지나 로그에 포함하지 않습니다.
- AssemblyAI API 주소는 Adapter 내부의 `https://api.assemblyai.com`으로 고정하며 업로드 URL도 AssemblyAI HTTPS 도메인인지 검증합니다.
- remote transcript ID를 받은 뒤에는 완료·실패·취소·timeout 모두 DELETE를 시도합니다. 삭제 실패는 자격 증명이나 응답 본문 없이 서버 경고로 남깁니다.
- 로컬 Job과 미디어는 현재 메모리에 있으므로 서버 재시작 시 사라집니다.

## 보안 및 배포

- API 키는 서버 환경 변수에만 저장하고 브라우저 코드, localStorage, 프로젝트 JSON에 넣지 않습니다.
- 실제 미디어가 AssemblyAI로 전송되므로 서비스의 데이터 처리·보관·리전·규정 준수 조건을 배포 전에 확인해야 합니다.
- 로컬 STT API에는 아직 사용자 인증과 rate limit이 없습니다. 기본 개발 서버는 loopback에 바인딩하고, 공유 배포 시 인증·소유권 검증·rate limit·TLS가 있는 reverse proxy 뒤에 둡니다.
- `HOST=0.0.0.0`은 신뢰할 수 없는 네트워크에서 직접 사용하지 않습니다.

## 적용 원칙

STT 완료 결과는 프로젝트에 즉시 반영하지 않습니다.

1. Job 완료
2. 자막 제안 목록 표시
3. 사용자가 결과 검토
4. `타임라인에 적용` 승인
5. 원본 클립의 source time을 timeline time으로 변환
6. 한 번의 Undo로 전체 적용 복구

독립 실행형 `file://` HTML에서는 API를 호출할 수 없으므로 수동 SRT/VTT 기능만 사용할 수 있습니다. 자동 자막은 `npm run dev`로 실행해야 합니다.
