const ASSEMBLYAI_API_BASE = 'https://api.assemblyai.com';
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function numberSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, minimum, maximum) : fallback;
}

function booleanSetting(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function abortError() {
  return new DOMException('AssemblyAI 전사가 취소되었습니다.', 'AbortError');
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function normalizeLanguageCode(language) {
  const code = String(language || 'ko').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(code) ? code : 'ko';
}

function retryDelay(response, attempt, initialDelay, maximumDelay, remaining) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    const milliseconds = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : NaN;
    if (Number.isFinite(milliseconds)) return milliseconds <= remaining ? milliseconds : null;
  }
  return Math.min(remaining, maximumDelay, initialDelay * (2 ** attempt));
}

function wait(milliseconds, signal) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const cancelled = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener('abort', cancelled);
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

function abortable(promise, signal, onAbort) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      onAbort?.();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener('abort', cancelled);
    signal?.addEventListener('abort', cancelled, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function readJson(response, maximumBytes, signal) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maximumBytes) throw new Error('AssemblyAI 응답이 허용 크기를 초과했습니다.');
  if (!response.body?.getReader) {
    const text = await abortable(response.text(), signal);
    if (Buffer.byteLength(text) > maximumBytes) throw new Error('AssemblyAI 응답이 허용 크기를 초과했습니다.');
    try { return JSON.parse(text); } catch { throw new Error('AssemblyAI가 올바른 JSON을 반환하지 않았습니다.'); }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await abortable(reader.read(), signal, () => { void reader.cancel().catch(() => undefined); });
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('AssemblyAI 응답이 허용 크기를 초과했습니다.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('AssemblyAI가 올바른 JSON을 반환하지 않았습니다.'); }
}

function statusError(status) {
  if (status === 401 || status === 403) return new Error('AssemblyAI API 키 또는 권한을 확인하세요.');
  if (status === 413) return new Error('AssemblyAI 업로드 허용 크기를 초과했습니다.');
  if (status === 400 || status === 422) return new Error('AssemblyAI가 미디어 또는 전사 요청을 처리하지 못했습니다.');
  if (status === 429) return new Error('AssemblyAI 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.');
  if (status >= 500) return new Error('AssemblyAI 서비스가 일시적으로 응답하지 않습니다.');
  return new Error(`AssemblyAI 요청에 실패했습니다. (${status})`);
}

async function requestWithRetry({
  fetchImpl,
  url,
  apiKey,
  method = 'GET',
  headers = {},
  body,
  signal,
  deadline,
  requestTimeoutMs,
  maximumResponseBytes,
  retryStatuses = RETRYABLE_STATUSES,
  retryAttempts,
  retryInitialDelayMs,
  retryMaximumDelayMs,
  expectJson = true,
}) {
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    assertNotAborted(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('AssemblyAI 전사 제한 시간이 초과되었습니다.');
    const controller = new AbortController();
    let requestTimedOut = false;
    const cancelled = () => controller.abort(signal?.reason || abortError());
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancelled);
    };
    signal?.addEventListener('abort', cancelled, { once: true });
    const timeout = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, Math.max(1, Math.min(requestTimeoutMs, remaining)));
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: apiKey, ...headers },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      cleanup();
      if (signal?.aborted) throw abortError();
      const remainingAfterFailure = deadline - Date.now();
      const canRetry = attempt < retryAttempts && remainingAfterFailure > 0;
      if (!canRetry) {
        throw new Error(requestTimedOut
          ? 'AssemblyAI 요청 시간이 초과되었습니다.'
          : 'AssemblyAI에 연결할 수 없습니다.');
      }
      await wait(Math.min(remainingAfterFailure, retryMaximumDelayMs, retryInitialDelayMs * (2 ** attempt)), signal);
      continue;
    }
    let delayBeforeRetry;
    try {
      if (response.ok) {
        if (!expectJson) {
          await abortable(response.body?.cancel?.() || Promise.resolve(), controller.signal);
          return null;
        }
        return await readJson(response, maximumResponseBytes, controller.signal);
      }
      const canRetry = retryStatuses.has(response.status) && attempt < retryAttempts;
      await abortable(response.body?.cancel?.() || Promise.resolve(), controller.signal);
      if (!canRetry) throw statusError(response.status);
      const remainingBeforeRetry = deadline - Date.now();
      delayBeforeRetry = retryDelay(response, attempt, retryInitialDelayMs, retryMaximumDelayMs, remainingBeforeRetry);
      if (delayBeforeRetry === null || remainingBeforeRetry <= 0) throw statusError(response.status);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (requestTimedOut || controller.signal.aborted) throw new Error('AssemblyAI 요청 시간이 초과되었습니다.');
      throw error;
    } finally {
      cleanup();
    }
    await wait(delayBeforeRetry, signal);
  }
  throw new Error('AssemblyAI 요청 재시도 횟수를 초과했습니다.');
}

function normalizedSpeaker(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const speaker = String(value).trim();
  return speaker.toLowerCase().startsWith('speaker-') ? speaker : `speaker-${speaker}`;
}

function segmentFromUtterance(utterance) {
  return {
    start: Number(utterance.start) / 1000,
    end: Number(utterance.end) / 1000,
    text: String(utterance.text || '').trim(),
    confidence: Number.isFinite(Number(utterance.confidence)) ? Number(utterance.confidence) : undefined,
    speaker: normalizedSpeaker(utterance.speaker),
  };
}

function segmentsFromWords(words) {
  const segments = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.parts.join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    segments.push({
      start: current.start / 1000,
      end: current.end / 1000,
      text,
      confidence: current.confidences.length
        ? current.confidences.reduce((total, value) => total + value, 0) / current.confidences.length
        : undefined,
      speaker: current.speaker,
    });
    current = null;
  };
  for (const word of words) {
    const start = Number(word.start);
    const end = Number(word.end);
    const text = String(word.text || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    const speaker = normalizedSpeaker(word.speaker);
    const startsNewSegment = current && (
      start - current.end > 800
      || start - current.start > 10000
      || current.parts.length >= 32
      || (speaker && current.speaker && speaker !== current.speaker)
    );
    if (startsNewSegment) flush();
    current ||= { start, end, parts: [], confidences: [], speaker };
    current.end = end;
    current.parts.push(text);
    if (Number.isFinite(Number(word.confidence))) current.confidences.push(Number(word.confidence));
    if (!current.speaker) current.speaker = speaker;
    if (/[.!?。！？]$/.test(text) && current.parts.length >= 4) flush();
  }
  flush();
  return segments;
}

export function normalizeAssemblyAiTranscript(payload, { language, duration }) {
  let segments = Array.isArray(payload?.utterances)
    ? payload.utterances.map(segmentFromUtterance)
    : [];
  if (!segments.length && Array.isArray(payload?.words)) segments = segmentsFromWords(payload.words);
  if (!segments.length && String(payload?.text || '').trim()) {
    const payloadDuration = Number(payload.audio_duration);
    segments = [{
      start: 0,
      end: Math.max(0.1, Number.isFinite(payloadDuration) ? payloadDuration : Number(duration) || 0.1),
      text: String(payload.text).trim(),
      confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : undefined,
    }];
  }
  return {
    language: normalizeLanguageCode(payload?.language_code || language),
    segments,
  };
}

export function createAssemblyAiProvider({
  apiKey,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 45000,
  uploadTimeoutMs = 10 * 60 * 1000,
  transcriptTimeoutMs = 2 * 60 * 60 * 1000,
  pollInitialDelayMs = 1200,
  pollMaximumDelayMs = 10000,
  retryAttempts = 3,
  retryInitialDelayMs = 500,
  retryMaximumDelayMs = 8000,
  maximumResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  speakerLabels = true,
  speechModels = ['universal-3-pro', 'universal-2'],
  logger = console,
} = {}) {
  const credential = String(apiKey || '').trim();
  if (!credential) throw new Error('ASSEMBLYAI_API_KEY가 필요합니다.');
  if (typeof fetchImpl !== 'function') throw new Error('AssemblyAI Provider에는 fetch 구현이 필요합니다.');
  const models = (Array.isArray(speechModels) ? speechModels : String(speechModels || '').split(','))
    .map((model) => String(model).trim())
    .filter((model) => /^[a-z0-9-]{1,64}$/.test(model));
  if (!models.length) throw new Error('ASSEMBLYAI_SPEECH_MODELS에 유효한 모델이 필요합니다.');
  const settings = {
    requestTimeoutMs: numberSetting(requestTimeoutMs, 45000, 1000, 10 * 60 * 1000),
    uploadTimeoutMs: numberSetting(uploadTimeoutMs, 10 * 60 * 1000, 1000, 30 * 60 * 1000),
    transcriptTimeoutMs: numberSetting(transcriptTimeoutMs, 2 * 60 * 60 * 1000, 10000, 12 * 60 * 60 * 1000),
    pollInitialDelayMs: numberSetting(pollInitialDelayMs, 1200, 50, 30000),
    pollMaximumDelayMs: numberSetting(pollMaximumDelayMs, 10000, 100, 60000),
    retryAttempts: Math.round(numberSetting(retryAttempts, 3, 0, 8)),
    retryInitialDelayMs: numberSetting(retryInitialDelayMs, 500, 10, 30000),
    retryMaximumDelayMs: numberSetting(retryMaximumDelayMs, 8000, 50, 60000),
    maximumResponseBytes: numberSetting(maximumResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 32 * 1024 * 1024),
    speakerLabels: booleanSetting(speakerLabels),
  };

  const providerRequest = (path, options = {}) => requestWithRetry({
    fetchImpl,
    url: `${ASSEMBLYAI_API_BASE}${path}`,
    apiKey: credential,
    signal: options.signal,
    deadline: options.deadline,
    requestTimeoutMs: options.requestTimeoutMs || settings.requestTimeoutMs,
    maximumResponseBytes: settings.maximumResponseBytes,
    retryAttempts: settings.retryAttempts,
    retryInitialDelayMs: settings.retryInitialDelayMs,
    retryMaximumDelayMs: settings.retryMaximumDelayMs,
    ...options,
  });

  return {
    name: 'assemblyai',
    demo: false,
    async transcribe(input) {
      const deadline = Date.now() + settings.transcriptTimeoutMs;
      let remoteTranscriptId = '';
      let deleting = null;
      const deleteRemoteTranscript = () => {
        if (!remoteTranscriptId) return Promise.resolve();
        deleting ||= providerRequest(`/v2/transcript/${encodeURIComponent(remoteTranscriptId)}`, {
          method: 'DELETE',
          deadline: Date.now() + Math.min(30000, settings.requestTimeoutMs),
          requestTimeoutMs: Math.min(30000, settings.requestTimeoutMs),
          retryAttempts: 1,
          expectJson: false,
        }).catch(() => {
          logger?.warn?.('AssemblyAI 원격 transcript 정리에 실패했습니다.');
        });
        return deleting;
      };
      const cancelRemote = () => { void deleteRemoteTranscript(); };
      input.signal?.addEventListener('abort', cancelRemote, { once: true });
      try {
        const upload = await providerRequest('/v2/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: input.media,
          signal: input.signal,
          deadline,
          requestTimeoutMs: settings.uploadTimeoutMs,
          retryStatuses: new Set([...RETRYABLE_STATUSES, 422]),
        });
        const uploadUrl = new URL(String(upload?.upload_url || ''));
        if (uploadUrl.protocol !== 'https:' || (!uploadUrl.hostname.endsWith('.assemblyai.com') && uploadUrl.hostname !== 'assemblyai.com')) {
          throw new Error('AssemblyAI가 안전한 업로드 URL을 반환하지 않았습니다.');
        }
        input.onProgress?.(0.42, 'AssemblyAI 업로드 완료');
        const transcript = await providerRequest('/v2/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio_url: uploadUrl.toString(),
            speech_models: models,
            language_code: normalizeLanguageCode(input.language),
            speaker_labels: settings.speakerLabels,
            format_text: true,
            punctuate: true,
          }),
          signal: input.signal,
          deadline,
          retryAttempts: 0,
          retryStatuses: new Set(),
        });
        const transcriptId = String(transcript?.id || '');
        if (!/^[a-zA-Z0-9-]{1,128}$/.test(transcriptId)) throw new Error('AssemblyAI가 올바른 transcript ID를 반환하지 않았습니다.');
        remoteTranscriptId = transcriptId;
        if (input.signal?.aborted) {
          await deleteRemoteTranscript();
          throw abortError();
        }
        input.onProgress?.(0.55, 'AssemblyAI 전사 대기 중');
        let pollDelay = settings.pollInitialDelayMs;
        let pollCount = 0;
        while (Date.now() < deadline) {
          await wait(pollDelay, input.signal);
          const result = await providerRequest(`/v2/transcript/${encodeURIComponent(remoteTranscriptId)}`, {
            signal: input.signal,
            deadline,
          });
          const status = String(result?.status || '').toLowerCase();
          if (status === 'completed') {
            input.onProgress?.(0.96, 'AssemblyAI 결과 정리 중');
            const normalized = normalizeAssemblyAiTranscript(result, input);
            await deleteRemoteTranscript();
            return normalized;
          }
          if (status === 'error') throw new Error('AssemblyAI 전사 처리에 실패했습니다.');
          if (status !== 'queued' && status !== 'processing') throw new Error('AssemblyAI가 알 수 없는 전사 상태를 반환했습니다.');
          pollCount += 1;
          input.onProgress?.(Math.min(0.92, 0.58 + pollCount * 0.025), status === 'queued' ? 'AssemblyAI 작업 대기 중' : 'AssemblyAI 음성 분석 중');
          pollDelay = Math.min(settings.pollMaximumDelayMs, Math.round(pollDelay * 1.45));
        }
        throw new Error('AssemblyAI 전사 제한 시간이 초과되었습니다.');
      } catch (error) {
        await deleteRemoteTranscript();
        if (input.signal?.aborted || error?.name === 'AbortError') {
          throw abortError();
        }
        throw error;
      } finally {
        input.signal?.removeEventListener('abort', cancelRemote);
      }
    },
  };
}
