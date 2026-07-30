/**
 * Server unit tests — node:test + node:assert
 * Run: npm test
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAssemblyAiTranscript } from '../server/assemblyai-provider.mjs';
import { createLlmProvider } from '../server/llm-service.mjs';
import { createSttProvider, createSttService } from '../server/stt-service.mjs';
import { buildRenderPlan } from '../server/render-service.mjs';

// ─── AssemblyAI Transcript Normalization ────────────────────────────────────

describe('normalizeAssemblyAiTranscript', () => {
  it('extracts segments from utterances', () => {
    const payload = {
      utterances: [
        { start: 1000, end: 3000, text: '안녕하세요', confidence: 0.95, speaker: 'A' },
        { start: 3500, end: 5200, text: '반갑습니다', confidence: 0.88, speaker: 'B' },
      ],
      language_code: 'ko',
    };
    const result = normalizeAssemblyAiTranscript(payload, { language: 'ko', duration: 10 });
    assert.equal(result.language, 'ko');
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].text, '안녕하세요');
    assert.equal(result.segments[0].start, 1);
    assert.equal(result.segments[0].end, 3);
  });

  it('falls back to words when utterances missing', () => {
    const payload = {
      words: [
        { start: 0, end: 500, text: '첫번째', confidence: 0.9 },
        { start: 500, end: 1200, text: '단어입니다', confidence: 0.85 },
        { start: 5000, end: 6000, text: '두번째', confidence: 0.92 },
      ],
      language_code: 'ko',
    };
    const result = normalizeAssemblyAiTranscript(payload, { language: 'ko', duration: 10 });
    assert.equal(result.language, 'ko');
    assert.ok(result.segments.length >= 1, 'should produce segments from words');
  });

  it('falls back to full text when no utterances or words', () => {
    const payload = {
      text: '전체 텍스트만 있는 경우',
      audio_duration: 5.5,
      language_code: 'en',
    };
    const result = normalizeAssemblyAiTranscript(payload, { language: 'en', duration: 5.5 });
    assert.equal(result.language, 'en');
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].text, '전체 텍스트만 있는 경우');
    assert.equal(result.segments[0].start, 0);
    assert.equal(result.segments[0].end, 5.5);
  });

  it('returns empty segments for empty payload', () => {
    const result = normalizeAssemblyAiTranscript({}, { language: 'ko', duration: 10 });
    assert.equal(result.segments.length, 0);
  });

  it('normalizes language codes', () => {
    const payload = { utterances: [{ start: 0, end: 1000, text: 'test', confidence: 1 }], language_code: 'ko-KR' };
    const result = normalizeAssemblyAiTranscript(payload, { language: 'ko', duration: 5 });
    assert.equal(result.language, 'ko');
  });
});

// ─── LLM Provider Creation ──────────────────────────────────────────────────

describe('createLlmProvider', () => {
  it('creates disabled provider by default', () => {
    const provider = createLlmProvider({ LLM_PROVIDER: 'disabled' });
    assert.equal(provider.available, false);
    assert.equal(provider.name, 'disabled');
  });

  it('creates disabled provider for empty env', () => {
    const provider = createLlmProvider({});
    assert.equal(provider.available, false);
  });

  it('creates mock provider', () => {
    const provider = createLlmProvider({ LLM_PROVIDER: 'mock' });
    assert.equal(provider.available, true);
    assert.equal(provider.name, 'mock');
    assert.equal(provider.demo, true);
  });

  it('requires API key and model for openai-compatible', () => {
    const provider = createLlmProvider({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://localhost:11434/v1',
    });
    assert.equal(provider.available, false, 'should be disabled without key/model');
  });

  it('creates openai-compatible provider with all config', () => {
    const mockFetch = () => Promise.resolve(new Response('{}'));
    const provider = createLlmProvider({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_API_KEY: 'test-key',
      LLM_MODEL: 'qwen2.5:7b',
    }, { fetchImpl: mockFetch });
    assert.equal(provider.available, true);
    assert.equal(provider.name, 'openai-compatible');
    assert.equal(provider.model, 'qwen2.5:7b');
  });

  it('rejects unsupported provider name', () => {
    const provider = createLlmProvider({ LLM_PROVIDER: 'unknown-provider' });
    assert.equal(provider.available, false);
  });

  it('rejects invalid base URL', () => {
    const provider = createLlmProvider({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'not-a-url',
      LLM_API_KEY: 'key',
      LLM_MODEL: 'model',
    });
    assert.equal(provider.available, false);
  });
});

// ─── STT Provider Creation ──────────────────────────────────────────────────

describe('createSttProvider', () => {
  it('creates mock provider by default', () => {
    const provider = createSttProvider({ STT_PROVIDER: 'mock' });
    assert.equal(provider.name, 'mock');
    assert.equal(provider.demo, true);
  });

  it('creates mock when no env specified', () => {
    const provider = createSttProvider({});
    assert.equal(provider.name, 'mock');
  });
});

// ─── STT Service Job Lifecycle ──────────────────────────────────────────────

describe('createSttService', () => {
  let service;
  let mockProvider;

  beforeEach(() => {
    mockProvider = {
      name: 'test-mock',
      demo: true,
      transcribe: async ({ onProgress }) => {
        onProgress(0.5, '분석 중');
        return {
          language: 'ko',
          segments: [{ start: 0, end: 2, text: '테스트 자막', confidence: 0.99 }],
        };
      },
      cancel: async () => {},
    };
    service = createSttService({ provider: mockProvider, maximumUploadBytes: 1024 * 1024 });
  });

  it('returns health status', async () => {
    const { req, res, body } = createMockHttp('GET', '/api/stt/health');
    const handled = await service.handleRequest(req, res, new URL('http://localhost/api/stt/health'));
    assert.equal(handled, true);
    const data = JSON.parse(body());
    assert.equal(data.status, 'ok');
    assert.equal(data.provider, 'test-mock');
  });

  it('rejects jobs with no content-type', async () => {
    const { req, res, body } = createMockHttp('POST', '/api/stt/jobs', {
      headers: { 'content-type': 'text/plain', 'content-length': '100' },
    });
    const handled = await service.handleRequest(req, res, new URL('http://localhost/api/stt/jobs'));
    assert.equal(handled, true);
    const data = JSON.parse(body());
    assert.ok(data.error, 'should return error for non-media content-type');
  });

  it('handles unknown routes by returning false', async () => {
    const { req, res } = createMockHttp('GET', '/api/unknown');
    const handled = await service.handleRequest(req, res, new URL('http://localhost/api/unknown'));
    assert.equal(handled, false);
  });
});

// ─── Render Plan Builder ────────────────────────────────────────────────────

describe('buildRenderPlan', () => {
  const baseProject = {
    canvas: { ratio: '9:16', width: 1080, height: 1920, background: '#11151d' },
    duration: 10,
    assets: [
      { id: 'asset1', kind: 'video', name: 'clip.mp4' },
      { id: 'asset2', kind: 'audio', name: 'bgm.mp3' },
    ],
    clips: [
      { id: 'c1', assetId: 'asset1', trackId: 'video', timelineStart: 0, sourceStart: 0, sourceEnd: 5, volume: 1 },
      { id: 'c2', assetId: 'asset2', trackId: 'audio', timelineStart: 0, sourceStart: 0, sourceEnd: 10, volume: 0.8 },
    ],
    texts: [
      { id: 't1', text: '자막 텍스트', start: 1, end: 4, x: 50, y: 85, fontSize: 48, fontWeight: 700, color: '#ffffff', background: '#000000bb', align: 'center', role: 'caption' },
    ],
  };
  const assetFiles = new Map([
    ['asset1', { path: '/tmp/clip.mp4' }],
    ['asset2', { path: '/tmp/bgm.mp3' }],
  ]);
  const probes = new Map([
    ['asset1', { hasVideo: true, hasAudio: true, width: 1920, height: 1080 }],
    ['asset2', { hasVideo: false, hasAudio: true }],
  ]);

  it('produces a valid render plan with draft quality', () => {
    const plan = buildRenderPlan(baseProject, assetFiles, probes, 'draft');
    assert.equal(plan.width, 540);
    assert.ok(plan.height > plan.width, 'should be vertical for 9:16');
    assert.ok(plan.filterComplex.length > 0, 'filter complex should not be empty');
    assert.ok(plan.args.length > 0, 'should have ffmpeg arguments');
    assert.ok(plan.duration === 10);
  });

  it('produces HD quality output', () => {
    const plan = buildRenderPlan(baseProject, assetFiles, probes, 'hd');
    assert.equal(plan.width, 1080);
  });

  it('handles project with no clips', () => {
    const emptyProject = { ...baseProject, clips: [], texts: [] };
    const plan = buildRenderPlan(emptyProject, new Map(), new Map(), 'draft');
    assert.ok(plan.filterComplex.length > 0, 'base color filter should still exist');
  });

  it('includes text overlay in filter graph', () => {
    const plan = buildRenderPlan(baseProject, assetFiles, probes, 'draft');
    assert.ok(plan.filterComplex.includes('drawtext'), 'should contain drawtext for subtitles');
  });

  it('handles reframe crop for vertical conversion', () => {
    const projectWithReframe = {
      ...baseProject,
      clips: [
        { ...baseProject.clips[0], reframe: { enabled: true, keyframes: [{ time: 0, x: 0.3, y: 0.5, confidence: 0.9 }] } },
        baseProject.clips[1],
      ],
    };
    const plan = buildRenderPlan(projectWithReframe, assetFiles, probes, 'draft');
    assert.ok(plan.filterComplex.includes('crop'), 'should include crop filter for reframe');
  });
});

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createMockHttp(method, pathname, { headers = {}, body: reqBody = '' } = {}) {
  const chunks = [];
  const req = {
    method,
    url: pathname,
    headers: { host: 'localhost', ...headers },
    on(event, handler) {
      if (event === 'data' && reqBody) handler(Buffer.from(reqBody));
      if (event === 'end') handler();
      return this;
    },
    once() { return this; },
    removeListener() { return this; },
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writeHead(code, hdrs) { res.statusCode = code; res.headersSent = true; return res; },
    end(data) { if (data) chunks.push(typeof data === 'string' ? data : data.toString()); res.writableEnded = true; return res; },
    write(data) { chunks.push(typeof data === 'string' ? data : data.toString()); return res; },
  };
  return { req, res, body: () => chunks.join('') };
}
