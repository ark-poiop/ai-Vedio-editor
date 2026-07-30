#!/bin/bash
# Shortform Studio — macOS 원클릭 실행
# Whisper STT 서버 + Docker 앱 서버를 함께 시작합니다.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WHISPER_DIR="$SCRIPT_DIR/whisper-server"
WHISPER_PID=""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Shortform Studio 시작"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Whisper 서버 시작 ──────────────────────────────────────────
if [ -f "$WHISPER_DIR/.venv/bin/python3" ]; then
  echo "[1/2] Whisper STT 서버 시작 중... (포트 8787)"
  cd "$WHISPER_DIR"
  .venv/bin/python3 server.py &
  WHISPER_PID=$!
  cd "$SCRIPT_DIR"
  # 모델 로딩 대기 (최대 60초)
  echo "      모델 로딩 대기 중..."
  for i in $(seq 1 60); do
    if curl -s http://localhost:8787/health | grep -q '"ok"' 2>/dev/null; then
      echo "      ✓ Whisper 서버 준비 완료"
      break
    fi
    sleep 1
  done
else
  echo "[1/2] ⚠ Whisper 서버 미설치 — STT 기능 없이 시작합니다."
  echo "      설치: cd whisper-server && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
fi

# ─── Docker 앱 서버 시작 ──────────────────────────────────────
echo "[2/2] Docker 앱 서버 빌드 및 시작..."
docker compose up -d --build

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Shortform Studio 실행 중"
echo "    앱:     http://localhost:2210"
if [ -n "$WHISPER_PID" ]; then
echo "    Whisper: http://localhost:8787 (PID: $WHISPER_PID)"
fi
echo ""
echo "  종료: ./stop.sh 또는 Ctrl+C"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 종료 처리 ─────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "종료 중..."
  if [ -n "$WHISPER_PID" ] && kill -0 "$WHISPER_PID" 2>/dev/null; then
    kill "$WHISPER_PID" 2>/dev/null
    echo "  ✓ Whisper 서버 종료"
  fi
  docker compose down
  echo "  ✓ Docker 앱 종료"
  echo "완료."
}

trap cleanup SIGINT SIGTERM

# 포그라운드 대기 (Ctrl+C로 종료)
wait "$WHISPER_PID" 2>/dev/null || true
# Whisper가 죽으면 Docker도 정리
cleanup
