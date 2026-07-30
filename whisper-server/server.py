"""
MLX Whisper Large v3 Turbo — OpenAI-compatible Transcription API Server

Provides POST /v1/audio/transcriptions endpoint compatible with OpenAI Whisper API.
Optimized for Apple Silicon via mlx-whisper.

Usage:
    pip install mlx-whisper fastapi uvicorn python-multipart
    python server.py
    # → http://localhost:8787
"""

import asyncio
import os
import tempfile
import time
from pathlib import Path

import mlx_whisper
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(title="MLX Whisper STT Server", version="1.0.0")

# ─── Configuration ───────────────────────────────────────────────────────────
MODEL_ID = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
HOST = os.environ.get("WHISPER_HOST", "0.0.0.0")
PORT = int(os.environ.get("WHISPER_PORT", "8787"))
MAX_FILE_SIZE = int(os.environ.get("WHISPER_MAX_FILE_MB", "500")) * 1024 * 1024

# Preload model on startup
_model_loaded = False


@app.on_event("startup")
async def preload_model():
    """Warm up model on first startup to avoid cold-start latency."""
    global _model_loaded
    print(f"[whisper-server] Loading model: {MODEL_ID}")
    start = time.time()
    # Trigger model download/load by transcribing silence
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _warmup)
    _model_loaded = True
    print(f"[whisper-server] Model ready in {time.time() - start:.1f}s")


def _warmup():
    """Generate a tiny silent WAV and transcribe it to trigger model load."""
    import struct
    # 0.1s silence, 16kHz, 16-bit mono WAV
    samples = b'\x00\x00' * 1600
    header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + len(samples), b'WAVE',
        b'fmt ', 16, 1, 1, 16000, 32000, 2, 16,
        b'data', len(samples))
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.write(header + samples)
    tmp.close()
    try:
        mlx_whisper.transcribe(tmp.name, path_or_hf_repo=MODEL_ID)
    finally:
        os.unlink(tmp.name)


@app.get("/health")
async def health():
    return {"status": "ok" if _model_loaded else "loading", "model": MODEL_ID}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default="whisper-large-v3-turbo"),
    language: str = Form(default=""),
    response_format: str = Form(default="verbose_json"),
    temperature: float = Form(default=0.0),
):
    """
    OpenAI Whisper API compatible transcription endpoint.
    Returns segments with timestamps for subtitle generation.
    """
    if not _model_loaded:
        raise HTTPException(status_code=503, detail="Model is still loading")

    # Read uploaded file
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_FILE_SIZE // 1024 // 1024}MB)")
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    # Save to temp file (mlx_whisper needs file path)
    suffix = Path(file.filename or "audio").suffix or ".wav"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(content)
    tmp.close()

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, lambda: _transcribe(tmp.name, language, temperature))
    finally:
        os.unlink(tmp.name)

    # Format response
    if response_format == "text":
        return JSONResponse(content={"text": result.get("text", "")})

    # verbose_json: include segments with timestamps
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "id": seg.get("id", 0),
            "start": round(seg.get("start", 0), 3),
            "end": round(seg.get("end", 0), 3),
            "text": seg.get("text", "").strip(),
            "avg_logprob": seg.get("avg_logprob", 0),
            "no_speech_prob": seg.get("no_speech_prob", 0),
        })

    return JSONResponse(content={
        "text": result.get("text", ""),
        "language": result.get("language", language or "unknown"),
        "duration": result.get("duration", 0),
        "segments": segments,
    })


def _transcribe(file_path: str, language: str, temperature: float) -> dict:
    """Run mlx_whisper transcription (blocking, runs in executor)."""
    kwargs = {
        "path_or_hf_repo": MODEL_ID,
        "verbose": False,
        "temperature": temperature,
        "word_timestamps": False,
    }
    if language:
        kwargs["language"] = language

    result = mlx_whisper.transcribe(file_path, **kwargs)
    return result


if __name__ == "__main__":
    print(f"[whisper-server] Starting on {HOST}:{PORT}")
    print(f"[whisper-server] Model: {MODEL_ID}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
