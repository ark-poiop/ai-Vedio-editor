/**
 * Whisper Local STT Provider
 *
 * Connects to a local MLX Whisper API server (OpenAI Whisper API compatible).
 * Sends audio file via multipart upload, receives segments with timestamps.
 */

const DEFAULT_WHISPER_URL = 'http://localhost:8787';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for long audio

/**
 * @param {object} options
 * @param {string} [options.baseUrl] - Whisper server base URL
 * @param {number} [options.timeoutMs] - Request timeout in ms
 * @param {typeof globalThis.fetch} [options.fetchImpl] - fetch implementation
 */
export function createWhisperLocalProvider({
  baseUrl = DEFAULT_WHISPER_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = String(baseUrl).replace(/\/+$/, '');

  return {
    name: 'whisper-local',
    demo: false,

    async transcribe({ media, mimeType, fileName, duration, language, signal, onProgress }) {
      onProgress(0.05, 'Whisper 서버에 오디오를 전송하고 있습니다.');

      // Build multipart form data
      const formData = new FormData();
      const blob = new Blob([media], { type: mimeType || 'audio/wav' });
      formData.append('file', blob, fileName || 'audio.wav');
      formData.append('response_format', 'verbose_json');
      if (language) formData.append('language', language);
      formData.append('model', 'whisper-large-v3-turbo');

      // Create abort controller with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Whisper 요청 시간이 초과되었습니다.')), timeoutMs);
      const abortOnSignal = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abortOnSignal, { once: true });

      try {
        onProgress(0.1, 'Whisper가 음성을 인식하고 있습니다.');

        const response = await fetchImpl(`${url}/v1/audio/transcriptions`, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`Whisper 서버 응답 오류 (${response.status}): ${errorText.slice(0, 200)}`);
        }

        onProgress(0.85, '응답을 처리하고 있습니다.');

        const result = await response.json();

        // Normalize to provider contract format
        const segments = (result.segments || []).map((seg) => ({
          start: Number(seg.start) || 0,
          end: Number(seg.end) || 0,
          text: String(seg.text || '').trim(),
          confidence: Number.isFinite(seg.avg_logprob)
            ? Math.min(1, Math.max(0, Math.exp(seg.avg_logprob)))
            : undefined,
        })).filter((seg) => seg.text && seg.end > seg.start);

        onProgress(0.95, `${segments.length}개 구간을 인식했습니다.`);

        return {
          language: result.language || language || 'unknown',
          segments,
        };
      } catch (error) {
        if (controller.signal.aborted && signal?.aborted) {
          const abortError = new Error('STT 작업이 취소되었습니다.');
          abortError.name = 'AbortError';
          throw abortError;
        }
        if (error?.name === 'AbortError' || controller.signal.aborted) {
          throw new Error('Whisper 요청 시간이 초과되었습니다.');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortOnSignal);
      }
    },

    async cancel() {
      // Whisper server processes synchronously per request,
      // cancellation is handled via AbortSignal above
    },
  };
}
