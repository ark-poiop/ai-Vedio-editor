/**
 * Shortform Studio — State Module
 * Constants, utilities, state factory, and core state operations.
 */

// ─── Storage Keys ───────────────────────────────────────────────────────────
export const STORAGE_KEY = 'shortform-studio:project:v1';
export const REFRAME_DRAFT_KEY = 'shortform-studio:reframe-draft:v1';
export const LLM_PREFERENCE_KEY = 'shortform-studio:llm-preference:v1';
export const UI_PREFERENCE_KEY = 'shortform-studio:ui-preference:v1';
export const DB_NAME = 'shortform-studio';
export const DB_STORE = 'media-files';

// ─── Constants ──────────────────────────────────────────────────────────────
export const MAX_HISTORY = 50;
export const LABEL_WIDTH = 88;
export const ratios = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};
export const defaultUiPreferences = Object.freeze({
  libraryWidth: 250, inspectorWidth: 290, timelineHeight: 292,
  libraryVisible: true, inspectorVisible: true, timelineVisible: true,
  showSafeZone: true, compactToolbar: false, reducedMotion: false,
  transcriptionLanguage: 'ko',
});

// ─── Utilities ──────────────────────────────────────────────────────────────
export const uid = () => crypto.randomUUID();
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const clone = (value) => structuredClone(value);
export const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
export const formatTime = (seconds, frames = false) => {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const base = `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
  return frames ? `${base}:${String(Math.floor((safe % 1) * 30)).padStart(2, '0')}` : base;
};
export const formatSize = (bytes) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ─── Project Factory ────────────────────────────────────────────────────────
export const emptyProject = () => ({
  id: uid(), schemaVersion: 1, title: '새 숏폼 프로젝트',
  canvas: { ratio: '9:16', ...ratios['9:16'], background: '#11151d' },
  assets: [], clips: [], texts: [], duration: 30, updatedAt: new Date().toISOString(),
});

// ─── State Factory ──────────────────────────────────────────────────────────
export function createState() {
  return {
    project: emptyProject(), selection: null, selections: [], playhead: 0, playing: false, zoom: 18,
    past: [], future: [], saveStatus: 'loading', exportOpen: false, settingsOpen: false, appMenuOpen: false,
    modalReturnFocus: null,
    ui: { ...defaultUiPreferences },
    serverStatus: {
      refreshing: false,
      stt: { available: false, provider: '', demo: false, message: '확인 전' },
      render: { available: false, message: '확인 전' },
    },
    exportFormat: 'webm', exportError: '',
    exportCapability: { checked: false, loading: false, available: false, message: '서버 MP4 상태를 확인하지 않았습니다.' },
    exportProgress: { active: false, progress: 0, status: '', jobId: '', format: '' },
    previewVisual: null, previewAudio: null, activeVisualId: '', activeAudioId: '',
    animation: 0, lastFrameAt: 0, saveTimer: 0, draggedClip: '', captionMessage: '',
    sttJob: { active: false, status: 'idle', progress: 0, message: '', id: '', assetId: '', provider: '', demo: false },
    sttProposal: null, sttPollTimer: 0,
    llm: {
      semanticAssist: true, healthStatus: 'checking', configured: false, available: false,
      provider: '', model: '', demo: false, reasonCode: '', configurationSource: 'server-environment', restartRequired: false,
      persistent: true, message: 'LLM 서버 상태를 확인하고 있습니다.', controller: null,
      connection: {
        baseUrl: 'http://host.docker.internal:11434/v1', model: '', apiKey: '', busy: false, dirty: false,
        status: 'idle', message: '로컬 LLM 주소와 model ID를 입력하세요.',
      },
    },
    shortform: {
      analyzing: false, applying: false, status: 'idle', progress: 0, message: '', assetId: '', analysisVersion: 0,
      targetDuration: 30, candidates: [], selectedId: '', sceneCuts: [], previewEnd: 0,
    },
    reframe: {
      analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', analysisVersion: 0,
      sampleInterval: 1, method: '', keyframes: [],
    },
    silence: {
      analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', analysisVersion: 0,
      thresholdDb: -40, minimumDuration: 0.6, padding: 0.12, candidates: [],
    },
    inspectorAccordion: { canvas: true, selection: true, captions: false, stt: false, shortform: true, reframe: false, silence: false },
  };
}

// ─── State Operations ───────────────────────────────────────────────────────
export function recalculate(project) {
  const clipEnd = project.clips.reduce((max, clip) => Math.max(max, clip.timelineStart + clip.sourceEnd - clip.sourceStart), 0);
  const textEnd = project.texts.reduce((max, text) => Math.max(max, text.end), 0);
  return { ...project, duration: Math.max(15, clipEnd, textEnd), updatedAt: new Date().toISOString() };
}

export function persistable(project) {
  return { ...project, assets: project.assets.map((asset) => ({
    ...asset, url: '', thumbnail: asset.thumbnail?.startsWith('data:') ? asset.thumbnail : undefined,
  })) };
}

export function normalizeUiPreferences(value = {}) {
  return {
    libraryWidth: clamp(Number(value.libraryWidth) || defaultUiPreferences.libraryWidth, 180, 420),
    inspectorWidth: clamp(Number(value.inspectorWidth) || defaultUiPreferences.inspectorWidth, 220, 460),
    timelineHeight: clamp(Number(value.timelineHeight) || defaultUiPreferences.timelineHeight, 150, 520),
    libraryVisible: value.libraryVisible !== false,
    inspectorVisible: value.inspectorVisible !== false,
    timelineVisible: value.timelineVisible !== false,
    showSafeZone: value.showSafeZone !== false,
    compactToolbar: value.compactToolbar === true,
    reducedMotion: value.reducedMotion === true,
    transcriptionLanguage: ['ko', 'en', 'ja'].includes(value.transcriptionLanguage) ? value.transcriptionLanguage : 'ko',
  };
}
