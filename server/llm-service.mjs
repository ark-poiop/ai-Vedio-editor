const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CANDIDATES = 6;
const MAX_TOTAL_EXCERPT_BYTES = 16 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function serviceError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function readJsonBody(request, maximumBytes, signal, timeoutMs) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw serviceError('JSON 요청만 지원합니다.', 415);
  const contentLength = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw serviceError('LLM 요청이 허용 크기를 초과했습니다.', 413);
  let timeout;
  let abort;
  const interrupted = new Promise((_, reject) => {
    const stop = (error) => {
      if (!request.destroyed) request.destroy();
      reject(error);
    };
    abort = () => stop(signal.reason || serviceError('LLM 요청이 취소되었습니다.', 499));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => stop(serviceError('LLM 요청 본문 수신 시간이 초과되었습니다.', 408)), timeoutMs);
  });
  const reading = (async () => {
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > maximumBytes) throw serviceError('LLM 요청이 허용 크기를 초과했습니다.', 413);
      chunks.push(chunk);
    }
    if (!received) throw serviceError('LLM 요청 본문이 비어 있습니다.');
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw serviceError('LLM 요청 JSON 형식을 확인하세요.');
    }
  })();
  try {
    return await Promise.race([reading, interrupted]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function validateProviderUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LLM_BASE_URL 형식을 확인하세요.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('LLM_BASE_URL은 HTTPS 또는 loopback HTTP 주소여야 합니다.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('LLM_BASE_URL에 자격 증명, query 또는 fragment를 넣을 수 없습니다.');
  return url;
}

function completionEndpoint(baseUrl) {
  const url = new URL(baseUrl.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url;
}

function cleanText(value, maximumLength, field, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && value == null) return '';
    throw new Error(`LLM 응답의 ${field} 형식이 올바르지 않습니다.`);
  }
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ((required && !text) || text.length > maximumLength) throw new Error(`LLM 응답의 ${field} 길이가 허용 범위를 벗어났습니다.`);
  return text;
}

function validateInput(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw serviceError('LLM 요청 객체를 확인하세요.');
  if (!Array.isArray(payload.candidates) || !payload.candidates.length || payload.candidates.length > MAX_CANDIDATES) {
    throw serviceError(`후보는 1개 이상 ${MAX_CANDIDATES}개 이하여야 합니다.`);
  }
  const seen = new Set();
  let excerptBytes = 0;
  const candidates = payload.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw serviceError('후보 형식을 확인하세요.');
    const id = String(candidate.id || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || seen.has(id)) throw serviceError('후보 ID가 없거나 중복되었습니다.');
    seen.add(id);
    const score = Number(candidate.score);
    const start = Number(candidate.start);
    const end = Number(candidate.end);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw serviceError('후보 점수는 0~100이어야 합니다.');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 24 * 60 * 60) {
      throw serviceError('후보 시간 범위를 확인하세요.');
    }
    const title = String(candidate.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const transcriptExcerpt = String(candidate.transcriptExcerpt || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (transcriptExcerpt.length > 2400) throw serviceError('후보 transcript excerpt가 너무 깁니다.');
    excerptBytes += Buffer.byteLength(transcriptExcerpt, 'utf8');
    const reasons = Array.isArray(candidate.reasons)
      ? candidate.reasons.slice(0, 8).map((reason) => String(reason).replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean)
      : [];
    return { id, score: Math.round(score), start, end, duration: end - start, title, reasons, transcriptExcerpt };
  });
  if (excerptBytes > MAX_TOTAL_EXCERPT_BYTES) throw serviceError('후보 transcript excerpt 전체 크기가 너무 큽니다.', 413);
  const targetDuration = boundedInteger(payload.targetDuration, 30, 15, 60);
  const language = /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(String(payload.language || 'ko'))
    ? String(payload.language || 'ko').toLowerCase()
    : 'ko';
  return { candidates, targetDuration, language };
}

function validateSemanticOutput(payload, inputCandidates) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.candidates)) {
    throw new Error('LLM 응답에 candidates 배열이 없습니다.');
  }
  if (payload.candidates.length !== inputCandidates.length) throw new Error('LLM 응답 후보 수가 요청과 다릅니다.');
  const expectedIds = new Set(inputCandidates.map((candidate) => candidate.id));
  const seen = new Set();
  const results = payload.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('LLM 응답 후보 형식이 올바르지 않습니다.');
    const id = String(candidate.id || '');
    if (!expectedIds.has(id) || seen.has(id)) throw new Error('LLM 응답에 알 수 없거나 중복된 후보 ID가 있습니다.');
    seen.add(id);
    const semanticScore = Number(candidate.semanticScore);
    if (!Number.isFinite(semanticScore) || semanticScore < 0 || semanticScore > 100) throw new Error('LLM 의미 점수는 0~100이어야 합니다.');
    if (!Array.isArray(candidate.reasons) || !candidate.reasons.length || candidate.reasons.length > 4) {
      throw new Error('LLM 응답 근거는 1~4개여야 합니다.');
    }
    return {
      id,
      semanticScore: Math.round(semanticScore),
      title: cleanText(candidate.title, 80, 'title'),
      summary: cleanText(candidate.summary, 240, 'summary'),
      reasons: candidate.reasons.map((reason, index) => cleanText(reason, 80, `reasons[${index}]`)),
    };
  });
  if (seen.size !== expectedIds.size) throw new Error('LLM 응답에 누락된 후보가 있습니다.');
  return results;
}

function createDisabledProvider(reason = 'LLM Provider가 설정되지 않았습니다.') {
  return {
    name: 'disabled', model: '', demo: false, configured: false, available: false, reason,
    async rerank() { throw serviceError(reason, 503); },
  };
}

function excerptSummary(candidate) {
  const text = candidate.transcriptExcerpt || candidate.title || '장면 흐름을 중심으로 선택한 후보입니다.';
  return text.length > 110 ? `${text.slice(0, 109).trim()}…` : text;
}

function createMockProvider() {
  return {
    name: 'mock', model: 'deterministic-demo', demo: true, configured: true, available: true,
    async rerank({ candidates, signal }) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      return candidates.map((candidate, index) => ({
        id: candidate.id,
        semanticScore: Math.min(100, Math.max(0, candidate.score + (candidates.length - index) * 2)),
        title: candidate.title || `추천 숏폼 후보 ${index + 1}`,
        summary: excerptSummary(candidate),
        reasons: candidate.transcriptExcerpt ? ['핵심 발화가 한 구간에 모임', '앞뒤 맥락이 자연스럽게 이어짐'] : ['시각적 흐름이 명확함'],
      }));
    },
  };
}

async function readResponseJson(response, maximumBytes) {
  if (!String(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    throw new Error('LLM Provider가 JSON 응답을 반환하지 않았습니다.');
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error('LLM Provider 응답이 허용 크기를 초과했습니다.');
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body || []) {
    received += chunk.byteLength;
    if (received > maximumBytes) throw new Error('LLM Provider 응답이 허용 크기를 초과했습니다.');
    chunks.push(Buffer.from(chunk));
  }
  if (!received) throw new Error('LLM Provider 응답이 비어 있습니다.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('LLM Provider JSON 응답을 해석할 수 없습니다.');
  }
}

function createOpenAiCompatibleProvider({ apiKey, baseUrl, model, timeoutMs, maximumResponseBytes, fetchImpl }) {
  const endpoint = completionEndpoint(baseUrl);
  return {
    name: 'openai-compatible', model, demo: false, configured: true, available: true,
    async rerank({ candidates, targetDuration, language, signal }) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error('LLM Provider 요청 시간이 초과되었습니다.')), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'You rank short-form video candidates. Return only one JSON object with a candidates array. Preserve every candidate id exactly once. For each item return id, semanticScore (0-100), concise title, one-sentence summary, and 1-4 short reasons. Never change timestamps.',
              },
              {
                role: 'user',
                content: JSON.stringify({ language, targetDuration, candidates }),
              },
            ],
          }),
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) throw new Error('LLM Provider redirect는 허용되지 않습니다.');
        if (!response.ok) throw new Error(`LLM Provider 요청 실패 (${response.status})`);
        const payload = await readResponseJson(response, maximumResponseBytes);
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('LLM Provider 응답에 message content가 없습니다.');
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new Error('LLM Provider content가 엄격한 JSON 형식이 아닙니다.');
        }
        return parsed.candidates;
      } catch (error) {
        if (controller.signal.aborted) {
          if (signal?.aborted) throw signal.reason || Object.assign(new Error('LLM 요청이 취소되었습니다.'), { name: 'AbortError' });
          throw new Error('LLM Provider 요청 시간이 초과되었습니다.');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

export function createLlmProvider(environment = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const providerName = String(environment.LLM_PROVIDER || 'disabled').trim().toLowerCase();
  if (!providerName || providerName === 'disabled' || providerName === 'none') return createDisabledProvider();
  if (providerName === 'mock') return createMockProvider();
  if (providerName !== 'openai-compatible' && providerName !== 'openai') {
    return createDisabledProvider(`지원하지 않는 LLM Provider입니다: ${providerName}`);
  }
  const apiKey = String(environment.LLM_API_KEY || '').trim();
  const model = String(environment.LLM_MODEL || '').trim();
  if (!apiKey || !model) return createDisabledProvider('LLM_API_KEY와 LLM_MODEL이 필요합니다.');
  if (typeof fetchImpl !== 'function') return createDisabledProvider('이 Node.js 런타임은 fetch를 지원하지 않습니다.');
  try {
    const baseUrl = validateProviderUrl(String(environment.LLM_BASE_URL || 'https://api.openai.com/v1'));
    return createOpenAiCompatibleProvider({
      apiKey,
      baseUrl,
      model: model.slice(0, 160),
      timeoutMs: boundedInteger(environment.LLM_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000),
      maximumResponseBytes: boundedInteger(environment.LLM_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES, 4 * 1024, 1024 * 1024),
      fetchImpl,
    });
  } catch (error) {
    return createDisabledProvider(error instanceof Error ? error.message : 'LLM Provider 설정을 확인하세요.');
  }
}

export function createLlmService({
  provider = createLlmProvider(),
  maximumRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  requestBodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
  maximumConcurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const activeControllers = new Set();
  let closed = false;

  async function handleRequest(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/llm/health') {
      sendJson(response, 200, {
        status: closed ? 'closed' : provider.available ? 'ok' : 'unavailable',
        configured: Boolean(provider.configured),
        available: Boolean(!closed && provider.available),
        provider: provider.name,
        model: provider.model || '',
        demo: Boolean(provider.demo),
        features: ['shortform-rerank', 'title', 'summary', 'reasons'],
      });
      return true;
    }

    if (url.pathname !== '/api/llm/shortform/rerank') return false;
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '허용되지 않은 메서드입니다.' });
      return true;
    }
    if (closed || !provider.available) {
      sendJson(response, 503, { error: closed ? 'LLM 서비스가 종료 중입니다.' : 'LLM Provider가 설정되지 않았습니다.' });
      return true;
    }
    if (activeControllers.size >= maximumConcurrency) {
      sendJson(response, 429, { error: '동시에 처리할 수 있는 LLM 요청 수를 초과했습니다.' });
      return true;
    }

    const controller = new AbortController();
    activeControllers.add(controller);
    const abortOnDisconnect = () => {
      if (!response.writableEnded) controller.abort(Object.assign(new Error('클라이언트 연결이 종료되었습니다.'), { name: 'AbortError' }));
    };
    request.once('aborted', abortOnDisconnect);
    response.once('close', abortOnDisconnect);
    try {
      const input = validateInput(await readJsonBody(
        request,
        maximumRequestBytes,
        controller.signal,
        boundedInteger(requestBodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS, 100, 120_000),
      ));
      const providerCandidates = await provider.rerank({ ...input, signal: controller.signal });
      const semantic = validateSemanticOutput({ candidates: providerCandidates }, input.candidates);
      const semanticById = new Map(semantic.map((candidate) => [candidate.id, candidate]));
      const candidates = input.candidates.map((candidate) => {
        const enrichment = semanticById.get(candidate.id);
        const score = Math.round(candidate.score * 0.55 + enrichment.semanticScore * 0.45);
        return {
          id: candidate.id,
          score,
          deterministicScore: candidate.score,
          semanticScore: enrichment.semanticScore,
          title: enrichment.title,
          summary: enrichment.summary,
          reasons: [...enrichment.reasons, ...candidate.reasons].filter((reason, index, values) => values.indexOf(reason) === index).slice(0, 4),
          aiEnhanced: true,
        };
      }).sort((first, second) => second.score - first.score || second.deterministicScore - first.deterministicScore)
        .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
      sendJson(response, 200, {
        provider: provider.name,
        model: provider.model || '',
        demo: Boolean(provider.demo),
        candidates,
      });
    } catch (error) {
      if (response.writableEnded || response.destroyed) return true;
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      sendJson(response, aborted ? 499 : error.statusCode || 502, {
        error: aborted ? 'LLM 요청이 취소되었습니다.' : error instanceof Error ? error.message : 'LLM 후보 재평가에 실패했습니다.',
      });
    } finally {
      request.removeListener('aborted', abortOnDisconnect);
      response.removeListener('close', abortOnDisconnect);
      activeControllers.delete(controller);
    }
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const controller of activeControllers) controller.abort(Object.assign(new Error('서버 종료로 LLM 요청을 취소했습니다.'), { name: 'AbortError' }));
    await provider.close?.();
  }

  return { handleRequest, close, provider, activeControllers };
}
