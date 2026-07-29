import { randomUUID } from 'node:crypto';
import { createAssemblyAiProvider } from './assemblyai-provider.mjs';

const DEFAULT_MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_SEGMENT_COUNT = 20000;
const MAX_SEGMENT_TEXT_LENGTH = 4000;
const MAX_TRANSCRIPT_TEXT_LENGTH = 4 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    provider: job.provider,
    demo: job.demo,
    assetId: job.assetId,
    fileName: job.fileName,
    language: job.language,
    duration: job.duration,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
  };
}

async function readRequestBody(request, maximumBytes) {
  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength > maximumBytes) throw Object.assign(new Error('업로드 파일이 허용 크기를 초과했습니다.'), { statusCode: 413 });
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maximumBytes) throw Object.assign(new Error('업로드 파일이 허용 크기를 초과했습니다.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!received) throw Object.assign(new Error('음성 또는 영상 데이터가 비어 있습니다.'), { statusCode: 400 });
  return Buffer.concat(chunks);
}

function validateSegments(payload, duration) {
  if (!payload || !Array.isArray(payload.segments)) throw new Error('STT Provider가 segments 배열을 반환하지 않았습니다.');
  if (payload.segments.length > MAX_SEGMENT_COUNT) throw new Error('STT Provider의 자막 구간 수가 허용 한도를 초과했습니다.');
  const maximumTime = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : Infinity;
  let totalTextBytes = 0;
  return payload.segments.flatMap((segment) => {
    const start = Number(segment.start);
    const end = Number(segment.end);
    const text = String(segment.text || '').trim();
    totalTextBytes += Buffer.byteLength(text, 'utf8');
    if (totalTextBytes > MAX_TRANSCRIPT_TEXT_LENGTH) throw new Error('STT Provider의 자막 텍스트가 허용 크기를 초과했습니다.');
    if (text.length > MAX_SEGMENT_TEXT_LENGTH) throw new Error('STT Provider의 단일 자막이 허용 길이를 초과했습니다.');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start >= maximumTime || !text) return [];
    const boundedStart = Math.max(0, start);
    const boundedEnd = Math.min(maximumTime, end);
    if (boundedEnd - boundedStart < 0.05) return [];
    const confidence = Number(segment.confidence);
    return [{
      start: boundedStart,
      end: boundedEnd,
      text,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : undefined,
      speaker: segment.speaker ? String(segment.speaker).slice(0, 128) : undefined,
    }];
  }).sort((first, second) => first.start - second.start);
}

function createMockProvider() {
  return {
    name: 'mock',
    demo: true,
    async transcribe({ duration, language }) {
      await new Promise((resolve) => setTimeout(resolve, 260));
      const safeDuration = Math.max(1, Number(duration) || 12);
      const messages = language.startsWith('ko')
        ? ['AI가 음성을 분석해 자막 초안을 만들었습니다.', '결과를 확인한 뒤 타임라인에 적용할 수 있습니다.', '실제 서비스에서는 STT Provider의 인식 결과가 표시됩니다.']
        : ['AI created a draft transcript.', 'Review the result before applying it.', 'A production provider will return the recognized speech.'];
      const count = safeDuration < 3 ? 1 : safeDuration < 7 ? 2 : 3;
      const slot = safeDuration / count;
      return {
        language,
        segments: messages.slice(0, count).map((text, index) => ({
          start: Math.max(0, index * slot + Math.min(0.25, slot * 0.1)),
          end: Math.min(safeDuration, (index + 1) * slot - Math.min(0.15, slot * 0.08)),
          text,
          confidence: 0.99 - index * 0.02,
        })),
      };
    },
  };
}

function createWebhookProvider({ url, apiKey }) {
  if (!url) throw new Error('STT_PROVIDER_URL이 필요합니다.');
  return {
    name: 'webhook',
    demo: false,
    async transcribe(input) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': input.mimeType || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(input.fileName),
          'X-Asset-Duration': String(input.duration),
          'X-Language': input.language,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: input.media,
        signal: input.signal,
      });
      if (!response.ok) throw new Error(`STT Provider 요청 실패 (${response.status})`);
      return response.json();
    },
  };
}

export function createSttProvider(environment = process.env) {
  const providerName = (environment.STT_PROVIDER || 'mock').toLowerCase();
  if (providerName === 'mock') return createMockProvider();
  if (providerName === 'assemblyai') return createAssemblyAiProvider({
    apiKey: environment.ASSEMBLYAI_API_KEY || environment.STT_PROVIDER_API_KEY,
    requestTimeoutMs: environment.ASSEMBLYAI_REQUEST_TIMEOUT_MS,
    uploadTimeoutMs: environment.ASSEMBLYAI_UPLOAD_TIMEOUT_MS,
    transcriptTimeoutMs: environment.ASSEMBLYAI_TRANSCRIPT_TIMEOUT_MS,
    pollInitialDelayMs: environment.ASSEMBLYAI_POLL_INTERVAL_MS,
    speakerLabels: environment.ASSEMBLYAI_SPEAKER_LABELS,
    speechModels: environment.ASSEMBLYAI_SPEECH_MODELS || 'universal-3-pro,universal-2',
  });
  if (providerName === 'webhook') return createWebhookProvider({
    url: environment.STT_PROVIDER_URL,
    apiKey: environment.STT_PROVIDER_API_KEY,
  });
  throw new Error(`지원하지 않는 STT Provider입니다: ${providerName}`);
}

export function createSttService({ provider = createSttProvider(), maximumUploadBytes = DEFAULT_MAX_UPLOAD_BYTES } = {}) {
  const jobs = new Map();
  let closed = false;

  async function processJob(job, media, mimeType) {
    if (job.status === 'cancelled') return;
    job.status = 'processing';
    job.progress = 0.25;
    job.message = `${provider.name} Provider가 음성을 분석하고 있습니다.`;
    job.updatedAt = new Date().toISOString();
    try {
      const payload = await provider.transcribe({
        media,
        mimeType,
        fileName: job.fileName,
        duration: job.duration,
        language: job.language,
        signal: job.controller.signal,
        onProgress(progress, message) {
          if (job.status === 'cancelled') return;
          job.progress = Math.min(0.98, Math.max(job.progress, Number(progress) || 0));
          if (message) job.message = String(message).slice(0, 240);
          job.updatedAt = new Date().toISOString();
        },
      });
      if (job.status === 'cancelled') return;
      const segments = validateSegments(payload, job.duration);
      if (!segments.length) throw new Error('인식된 음성 구간이 없습니다.');
      job.status = 'completed';
      job.progress = 1;
      job.message = `자막 제안 ${segments.length}개가 준비되었습니다.`;
      job.result = {
        language: String(payload.language || job.language),
        duration: job.duration,
        segments,
      };
    } catch (error) {
      if (job.status === 'cancelled') return;
      job.status = 'failed';
      job.progress = 1;
      job.error = error instanceof Error ? error.message : 'STT 처리에 실패했습니다.';
      job.message = job.error;
    } finally {
      job.updatedAt = new Date().toISOString();
      job.controller = undefined;
      job.processPromise = undefined;
      job.startTimer = undefined;
    }
  }

  async function handleRequest(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/stt/health') {
      sendJson(response, closed ? 503 : 200, { status: closed ? 'closed' : 'ok', provider: provider.name, demo: provider.demo });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/stt/jobs') {
      if (closed) {
        sendJson(response, 503, { error: 'STT 서비스가 종료 중입니다.' });
        return true;
      }
      try {
        const mimeType = String(request.headers['content-type'] || 'application/octet-stream').split(';')[0];
        if (!mimeType.startsWith('audio/') && !mimeType.startsWith('video/')) {
          sendJson(response, 415, { error: 'STT는 오디오 또는 영상 파일만 지원합니다.' });
          return true;
        }
        const now = new Date().toISOString();
        const duration = Number(request.headers['x-asset-duration']);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60) {
          sendJson(response, 400, { error: '미디어 길이는 0초보다 크고 24시간 이하여야 합니다.' });
          return true;
        }
        const encodedName = String(request.headers['x-file-name'] || 'media').slice(0, 1024);
        let fileName = encodedName;
        try { fileName = decodeURIComponent(encodedName); } catch { /* use raw header */ }
        fileName = fileName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) || 'media';
        const language = String(request.headers['x-language'] || 'ko').trim().toLowerCase();
        if (!/^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/.test(language)) {
          sendJson(response, 400, { error: 'STT 언어 코드 형식을 확인하세요.' });
          return true;
        }
        const media = await readRequestBody(request, maximumUploadBytes);
        const job = {
          id: randomUUID(),
          status: 'queued',
          progress: 0,
          message: 'STT 작업을 준비하고 있습니다.',
          provider: provider.name,
          demo: provider.demo,
          assetId: String(request.headers['x-asset-id'] || '').slice(0, 128),
          fileName,
          language,
          duration,
          createdAt: now,
          updatedAt: now,
          result: null,
          error: null,
          controller: new AbortController(),
        };
        jobs.set(job.id, job);
        sendJson(response, 202, publicJob(job));
        job.startTimer = setTimeout(() => {
          job.processPromise = processJob(job, media, mimeType);
        }, 20);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error instanceof Error ? error.message : '업로드에 실패했습니다.' });
      }
      return true;
    }

    const match = url.pathname.match(/^\/api\/stt\/jobs\/([0-9a-f-]+)$/i);
    if (!match) return false;
    const job = jobs.get(match[1]);
    if (!job) {
      sendJson(response, 404, { error: 'STT Job을 찾을 수 없습니다.' });
      return true;
    }
    if (request.method === 'GET') {
      sendJson(response, 200, publicJob(job));
      return true;
    }
    if (request.method === 'DELETE') {
      if (!TERMINAL_STATUSES.has(job.status)) {
        job.status = 'cancelled';
        job.progress = 1;
        job.message = '자동 자막 작업을 취소했습니다.';
        job.updatedAt = new Date().toISOString();
        clearTimeout(job.startTimer);
        job.controller?.abort();
      }
      sendJson(response, 200, publicJob(job));
      return true;
    }
    sendJson(response, 405, { error: '허용되지 않은 메서드입니다.' });
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const pending = [];
    for (const job of jobs.values()) {
      if (TERMINAL_STATUSES.has(job.status)) continue;
      job.status = 'cancelled';
      job.progress = 1;
      job.message = '서버 종료로 자동 자막 작업을 취소했습니다.';
      job.updatedAt = new Date().toISOString();
      clearTimeout(job.startTimer);
      job.controller?.abort();
      if (job.processPromise) pending.push(job.processPromise);
    }
    await Promise.allSettled(pending);
    await provider.close?.();
  }

  return { handleRequest, close, jobs, provider };
}
