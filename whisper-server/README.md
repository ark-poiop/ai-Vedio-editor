# MLX Whisper STT Server

Apple Silicon 최적화 로컬 음성 인식 서버. OpenAI Whisper API 호환.

## 요구 사항

- macOS (Apple Silicon: M1/M2/M3/M4)
- Python 3.11+

## 설치 및 실행

```bash
cd whisper-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
# → http://localhost:8787
```

첫 실행 시 모델(`mlx-community/whisper-large-v3-turbo`, ~1.5GB)이 자동 다운로드됩니다.

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `WHISPER_MODEL` | `mlx-community/whisper-large-v3-turbo` | HuggingFace 모델 ID |
| `WHISPER_HOST` | `0.0.0.0` | 바인드 주소 |
| `WHISPER_PORT` | `8787` | 서버 포트 |
| `WHISPER_MAX_FILE_MB` | `500` | 최대 업로드 크기(MB) |

## API

### `GET /health`
```json
{ "status": "ok", "model": "mlx-community/whisper-large-v3-turbo" }
```

### `POST /v1/audio/transcriptions`

OpenAI Whisper API 호환. multipart/form-data로 오디오 파일 업로드.

```bash
curl -X POST http://localhost:8787/v1/audio/transcriptions \
  -F "file=@audio.mp3" \
  -F "language=ko" \
  -F "response_format=verbose_json"
```

응답:
```json
{
  "text": "전체 텍스트...",
  "language": "ko",
  "duration": 120.5,
  "segments": [
    { "id": 0, "start": 0.0, "end": 2.5, "text": "안녕하세요" },
    { "id": 1, "start": 2.8, "end": 5.1, "text": "오늘 이야기할..." }
  ]
}
```

## 성능 참고 (M1 Pro)

| 영상 길이 | 처리 시간 |
|-----------|-----------|
| 1분 | ~3초 |
| 5분 | ~12초 |
| 10분 | ~25초 |

## Shortform Studio 연동

`.env` 또는 설정 모달에서:
```env
STT_PROVIDER=whisper-local
WHISPER_URL=http://localhost:8787
```
