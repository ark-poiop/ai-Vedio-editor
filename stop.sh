#!/bin/bash
# Shortform Studio 종료
echo "Shortform Studio 종료 중..."
pkill -f "whisper-server/server.py" 2>/dev/null && echo "  ✓ Whisper 서버 종료" || echo "  - Whisper 서버 미실행"
docker compose down && echo "  ✓ Docker 앱 종료" || echo "  - Docker 앱 미실행"
echo "완료."
