import {
  STORAGE_KEY, REFRAME_DRAFT_KEY, LLM_PREFERENCE_KEY, UI_PREFERENCE_KEY,
  DB_NAME, DB_STORE, MAX_HISTORY, LABEL_WIDTH, ratios, defaultUiPreferences,
  uid, clamp, clone, escapeHtml, formatTime, formatSize,
  emptyProject, createState, recalculate, persistable, normalizeUiPreferences,
} from './state.js';

(() => {
  'use strict';

  const state = createState();
  let llmHealthPromise = null;

  // ─── Multi-selection helpers ────────────────────────────────────────────────
  function isSelected(kind, id) {
    return state.selections.some((s) => s.kind === kind && s.id === id);
  }
  function selectSingle(kind, id) {
    state.selection = { kind, id };
    state.selections = [{ kind, id }];
  }
  function selectToggle(kind, id) {
    const index = state.selections.findIndex((s) => s.kind === kind && s.id === id);
    if (index >= 0) {
      state.selections.splice(index, 1);
      state.selection = state.selections.length ? state.selections.at(-1) : null;
    } else {
      state.selections.push({ kind, id });
      state.selection = { kind, id };
    }
  }
  function selectAdd(kind, id) {
    if (!isSelected(kind, id)) state.selections.push({ kind, id });
    state.selection = { kind, id };
  }
  function clearSelection() {
    state.selection = null;
    state.selections = [];
  }

  function selectAllTimeline() {
    const clips = state.project.clips.map((clip) => ({ kind: 'clip', id: clip.id }));
    const texts = state.project.texts.map((text) => ({ kind: 'text', id: text.id }));
    state.selections = [...clips, ...texts];
    state.selection = state.selections.at(-1) || null;
    renderAll();
  }

  /** Timeline duration of a clip accounting for speed */
  function clipDuration(clip) { return (clip.sourceEnd - clip.sourceStart) / (clip.speed || 1); }
  /** Source time at given timeline time for a clip accounting for speed */
  function clipSourceTime(clip, timelineTime) { return clip.sourceStart + (timelineTime - clip.timelineStart) * (clip.speed || 1); }

  /** Effective volume at a given timeline time with fade in/out */
  function clipVolume(clip, time) {
    const dur = clipDuration(clip);
    const elapsed = time - clip.timelineStart;
    const remaining = dur - elapsed;
    let vol = clip.volume;
    const fadeIn = clip.fadeIn || 0;
    const fadeOut = clip.fadeOut || 0;
    if (fadeIn > 0 && elapsed < fadeIn) vol *= elapsed / fadeIn;
    if (fadeOut > 0 && remaining < fadeOut) vol *= remaining / fadeOut;
    return clamp(vol, 0, 1);
  }

  /** Available transition types */
  const TRANSITION_TYPES = ['none', 'fade', 'dissolve', 'wipe-left', 'wipe-right'];
  const TRANSITION_LABELS = { none: '없음', fade: '페이드', dissolve: '디졸브', 'wipe-left': '좌측 와이프', 'wipe-right': '우측 와이프' };

  /** Calculate transition opacity/progress for a clip at given time */
  function transitionProgress(clip, time) {
    const transition = clip.transition;
    if (!transition || transition.type === 'none' || !transition.duration) return null;
    const elapsed = time - clip.timelineStart;
    if (elapsed > transition.duration) return null;
    return { type: transition.type, progress: clamp(elapsed / transition.duration, 0, 1) };
  }

  /** Interpolate text keyframe properties at a given time (0-1 progress within text duration) */
  function interpolateTextKeyframes(text, time) {
    const progress = (time - text.start) / Math.max(0.01, text.end - text.start);
    const keyframes = text.keyframes;
    if (!keyframes || !keyframes.length) return { x: text.x, y: text.y, fontSize: text.fontSize, opacity: text.opacity ?? 1 };
    // Find surrounding keyframes
    let before = null, after = null;
    for (const kf of keyframes) {
      if (kf.t <= progress) before = kf;
      if (kf.t >= progress && !after) after = kf;
    }
    if (!before && !after) return { x: text.x, y: text.y, fontSize: text.fontSize, opacity: text.opacity ?? 1 };
    if (!before) before = after;
    if (!after) after = before;
    if (before === after) return { x: before.x ?? text.x, y: before.y ?? text.y, fontSize: before.fontSize ?? text.fontSize, opacity: before.opacity ?? text.opacity ?? 1 };
    const range = after.t - before.t;
    const t = range > 0 ? (progress - before.t) / range : 0;
    return {
      x: (before.x ?? text.x) + ((after.x ?? text.x) - (before.x ?? text.x)) * t,
      y: (before.y ?? text.y) + ((after.y ?? text.y) - (before.y ?? text.y)) * t,
      fontSize: (before.fontSize ?? text.fontSize) + ((after.fontSize ?? text.fontSize) - (before.fontSize ?? text.fontSize)) * t,
      opacity: (before.opacity ?? 1) + ((after.opacity ?? 1) - (before.opacity ?? 1)) * t,
    };
  }

  function persistUiPreferences() {
    try {
      localStorage.setItem(UI_PREFERENCE_KEY, JSON.stringify(state.ui));
    } catch { /* preference persistence is optional */ }
  }

  function applyUiPreferences() {
    const shell = document.querySelector('.app-shell');
    if (!shell) return;
    const shellWidth = shell.clientWidth || window.innerWidth || 1280;
    const handleWidth = (state.ui.libraryVisible ? 6 : 0) + (state.ui.inspectorVisible ? 6 : 0);
    const sideBudget = Math.max(400, shellWidth - 320 - handleWidth);
    let libraryWidth = state.ui.libraryVisible ? state.ui.libraryWidth : 0;
    let inspectorWidth = state.ui.inspectorVisible ? state.ui.inspectorWidth : 0;
    const sideTotal = libraryWidth + inspectorWidth;
    if (sideTotal > sideBudget && sideTotal > 0) {
      const overflow = sideTotal - sideBudget;
      const libraryCapacity = Math.max(0, libraryWidth - 180);
      const inspectorCapacity = Math.max(0, inspectorWidth - 220);
      const capacity = libraryCapacity + inspectorCapacity;
      if (capacity > 0) {
        libraryWidth -= overflow * (libraryCapacity / capacity);
        inspectorWidth -= overflow * (inspectorCapacity / capacity);
      }
    }
    const availableTimelineHeight = Math.max(150, (shell.clientHeight || window.innerHeight || 800) - 64 - 240 - 6);
    const timelineHeight = Math.min(state.ui.timelineHeight, availableTimelineHeight);
    shell.style.setProperty('--library-width', `${Math.round(libraryWidth)}px`);
    shell.style.setProperty('--inspector-width', `${Math.round(inspectorWidth)}px`);
    shell.style.setProperty('--timeline-height', `${Math.round(timelineHeight)}px`);
    shell.classList.toggle('library-hidden', !state.ui.libraryVisible);
    shell.classList.toggle('inspector-hidden', !state.ui.inspectorVisible);
    shell.classList.toggle('timeline-hidden', !state.ui.timelineVisible);
    shell.classList.toggle('compact-toolbar', state.ui.compactToolbar);
    shell.classList.toggle('reduced-motion', state.ui.reducedMotion);
    const appliedDimensions = { libraryWidth, inspectorWidth, timelineHeight };
    document.querySelectorAll('.layout-resizer').forEach((handle) => {
      handle.setAttribute('aria-valuenow', String(Math.round(appliedDimensions[handle.dataset.resize])));
    });
    document.querySelector('.safe-zone')?.toggleAttribute('hidden', !state.ui.showSafeZone);
    const menuButton = document.getElementById('appMenuButton');
    if (menuButton) menuButton.setAttribute('aria-expanded', String(state.appMenuOpen));
    const menu = document.getElementById('appMenu');
    if (menu) menu.hidden = !state.appMenuOpen;
  }

  function updateUiPreferences(patch, { persist = true, render = false } = {}) {
    state.ui = normalizeUiPreferences({ ...state.ui, ...patch });
    applyUiPreferences();
    if (persist) persistUiPreferences();
    if (render && state.settingsOpen) renderModal();
  }

  function applyLayoutPreset(preset) {
    const presets = {
      balanced: { libraryWidth: 250, inspectorWidth: 290, timelineHeight: 292, libraryVisible: true, inspectorVisible: true, timelineVisible: true },
      focus: { libraryVisible: false, inspectorVisible: false, timelineVisible: true, timelineHeight: 220 },
      timeline: { libraryWidth: 210, inspectorWidth: 250, timelineHeight: 430, libraryVisible: true, inspectorVisible: true, timelineVisible: true },
    };
    updateUiPreferences(presets[preset] || presets.balanced, { render: true });
  }

  function toggleAppMenu(force) {
    const menu = document.getElementById('appMenu');
    const wasOpen = state.appMenuOpen;
    state.appMenuOpen = typeof force === 'boolean' ? force : !state.appMenuOpen;
    applyUiPreferences();
    if (state.appMenuOpen) document.querySelector('#appMenu [role="menuitem"]:not(:disabled)')?.focus();
    else if (wasOpen && menu?.contains(document.activeElement)) document.getElementById('appMenuButton')?.focus();
  }

  function openSettings() {
    state.modalReturnFocus = document.activeElement;
    state.appMenuOpen = false;
    state.exportOpen = false;
    state.settingsOpen = true;
    applyUiPreferences();
    renderModal();
    queueMicrotask(() => document.getElementById('closeSettingsButton')?.focus());
    void loadRuntimeLlmConfiguration();
    void refreshServerStatus();
  }

  function closeSettings() {
    const returnFocus = state.modalReturnFocus;
    state.settingsOpen = false;
    state.modalReturnFocus = null;
    state.llm.connection = { ...state.llm.connection, apiKey: '' };
    renderModal();
    queueMicrotask(() => returnFocus?.isConnected && returnFocus.focus());
  }

  async function loadRuntimeLlmConfiguration() {
    if (location.protocol === 'file:') return;
    try {
      const response = await fetch('/api/llm/config', {
        headers: { Accept: 'application/json' }, cache: 'no-store',
      });
      if (!response.ok) return;
      const config = await response.json();
      if (state.llm.connection.dirty) return;
      state.llm.connection = {
        ...state.llm.connection,
        baseUrl: String(config.baseUrl || state.llm.connection.baseUrl).slice(0, 500),
        model: String(config.model || state.llm.connection.model).slice(0, 160),
      };
      if (state.settingsOpen) renderModal();
    } catch { /* health UI reports server availability separately */ }
  }

  async function configureLocalLlm(apply) {
    const connection = state.llm.connection;
    if (connection.busy) return;
    const baseUrl = connection.baseUrl.trim();
    const model = connection.model.trim();
    const apiKey = connection.apiKey.trim();
    if (!baseUrl || !model) {
      state.llm.connection = { ...connection, status: 'error', message: '로컬 LLM 주소와 model ID를 모두 입력하세요.' };
      renderModal();
      return;
    }
    state.llm.connection = {
      ...connection, baseUrl, model, busy: true, status: 'testing',
      message: apply ? '연결과 JSON 호환성을 확인한 뒤 적용하고 있습니다…' : '실제 응답으로 연결과 JSON 호환성을 확인하고 있습니다…',
    };
    renderModal();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(apply ? '/api/llm/config' : '/api/llm/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ baseUrl, model, apiKey }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || `연결 테스트 실패 (${response.status})`));
      state.llm.connection = {
        ...state.llm.connection, apiKey: apply ? '' : state.llm.connection.apiKey,
        busy: false, dirty: apply ? false : state.llm.connection.dirty, status: 'success',
        message: String(payload.message || (apply ? '현재 서버에 적용했습니다.' : '연결 테스트를 통과했습니다.')),
      };
      if (apply) {
        state.llm = {
          ...state.llm,
          healthStatus: 'available', configured: true, available: true,
          provider: String(payload.provider || 'openai-compatible').slice(0, 80),
          model: String(payload.model || model).slice(0, 160), demo: false, reasonCode: '',
          configurationSource: 'browser-runtime', restartRequired: false, persistent: false,
          message: `${payload.provider || 'openai-compatible'} · ${payload.model || model} 연결됨`,
        };
        renderInspector();
      }
    } catch (error) {
      state.llm.connection = {
        ...state.llm.connection, busy: false, status: 'error',
        message: error?.name === 'AbortError' ? '연결 테스트 시간이 초과되었습니다.' : String(error?.message || '로컬 LLM 연결에 실패했습니다.'),
      };
    } finally {
      clearTimeout(timeout);
      if (state.settingsOpen) renderModal();
    }
  }

  async function copyLlmEnvExample() {
    const button = document.getElementById('copyLlmEnvButton');
    const snippet = [
      'LLM_PROVIDER=openai-compatible',
      `LLM_BASE_URL=${state.llm.connection.baseUrl.trim() || 'http://host.docker.internal:11434/v1'}`,
      `LLM_MODEL=${state.llm.connection.model.trim() || 'replace-with-local-model-id'}`,
      'LLM_API_KEY=local-only',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(snippet);
      if (button) button.textContent = '설정 예시 복사됨';
    } catch {
      if (button) button.textContent = '복사 실패 · 아래 예시를 직접 복사하세요';
    }
    window.setTimeout(() => {
      const current = document.getElementById('copyLlmEnvButton');
      if (current) current.textContent = '영구 설정 예시 복사';
    }, 2200);
  }

  function bindLayoutResizer(handle) {
    const dimension = handle.dataset.resize;
    const horizontal = dimension === 'timelineHeight';
    const direction = dimension === 'inspectorWidth' || horizontal ? -1 : 1;
    const minimum = { libraryWidth: 180, inspectorWidth: 220, timelineHeight: 150 }[dimension];
    const maximum = { libraryWidth: 420, inspectorWidth: 460, timelineHeight: 520 }[dimension];
    const update = (value, persist = false) => {
      const bounded = clamp(Math.round(value), minimum, maximum);
      updateUiPreferences({ [dimension]: bounded }, { persist });
      handle.setAttribute('aria-valuenow', String(bounded));
    };
    handle.onpointerdown = (event) => {
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const start = horizontal ? event.clientY : event.clientX;
      const initial = state.ui[dimension];
      document.body.classList.add('is-resizing');
      const move = (moveEvent) => update(initial + ((horizontal ? moveEvent.clientY : moveEvent.clientX) - start) * direction);
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        document.body.classList.remove('is-resizing');
        persistUiPreferences();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
    };
    handle.onkeydown = (event) => {
      const decrease = horizontal ? event.key === 'ArrowDown' : event.key === 'ArrowLeft';
      const increase = horizontal ? event.key === 'ArrowUp' : event.key === 'ArrowRight';
      if (!decrease && !increase) return;
      event.preventDefault();
      update(state.ui[dimension] + (increase ? 12 : -12), true);
    };
  }

  async function refreshServerStatus() {
    if (state.serverStatus.refreshing) return;
    state.serverStatus.refreshing = true;
    if (state.settingsOpen) renderModal();
    const unavailable = (message) => ({ available: false, provider: '', demo: false, message });
    if (location.protocol === 'file:') {
      state.serverStatus.stt = unavailable('단일 HTML에서는 서버 기능을 사용할 수 없습니다.');
      state.serverStatus.render = { available: false, message: '단일 HTML에서는 서버 기능을 사용할 수 없습니다.' };
      state.serverStatus.refreshing = false;
      if (state.settingsOpen) renderModal();
      return;
    }
    const fetchHealth = async (path) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        return await response.json();
      } finally { clearTimeout(timeout); }
    };
    const [stt, render] = await Promise.allSettled([
      fetchHealth('/api/stt/health'),
      fetchHealth('/api/render/health'),
      refreshLlmHealth(),
    ]);
    state.serverStatus.stt = stt.status === 'fulfilled'
      ? { available: stt.value.status === 'ok', provider: String(stt.value.provider || ''), demo: stt.value.demo === true, message: stt.value.status === 'ok' ? '연결됨' : '사용 불가' }
      : unavailable('상태를 확인할 수 없습니다.');
    state.serverStatus.render = render.status === 'fulfilled'
      ? { available: render.value.available === true, message: String(render.value.message || (render.value.available ? 'FFmpeg 사용 가능' : 'FFmpeg 사용 불가')) }
      : { available: false, message: '상태를 확인할 수 없습니다.' };
    state.serverStatus.refreshing = false;
    if (state.settingsOpen) renderModal();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      };
    });
  }

  async function saveBlob(id, blob) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).put(blob, id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  async function loadBlob(id) {
    const db = await openDatabase();
    const result = await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  }

  async function removeBlob(id) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  function waitFor(element, event) {
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('미디어 파일을 읽을 수 없습니다.')); };
      const cleanup = () => { element.removeEventListener(event, done); element.removeEventListener('error', failed); };
      element.addEventListener(event, done, { once: true });
      element.addEventListener('error', failed, { once: true });
    });
  }

  /** Generate waveform peaks (128 samples) from audio file for timeline visualization */
  async function generateWaveform(file) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      const ctx = new AudioContextClass();
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      const channel = buffer.getChannelData(0);
      const peaks = 128;
      const blockSize = Math.floor(channel.length / peaks);
      const waveform = new Array(peaks);
      for (let i = 0; i < peaks; i++) {
        let sum = 0;
        const start = i * blockSize;
        const end = Math.min(start + blockSize, channel.length);
        for (let j = start; j < end; j++) sum += Math.abs(channel[j]);
        waveform[i] = Math.min(1, sum / (end - start) * 2.5);
      }
      await ctx.close();
      return waveform;
    } catch { return null; }
  }

  async function inspectFile(file, id) {
    const url = URL.createObjectURL(file);
    const kind = file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : 'video';
    let duration = 5, width = 0, height = 0, thumbnail;
    try {
      if (kind === 'video') {
        const video = document.createElement('video');
        video.preload = 'metadata'; video.muted = true; video.src = url;
        await waitFor(video, 'loadedmetadata');
        duration = Number.isFinite(video.duration) ? video.duration : 0;
        width = video.videoWidth; height = video.videoHeight;
        try {
          video.currentTime = Math.min(1, duration / 3);
          await waitFor(video, 'seeked');
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 320 / width);
          canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbnail = canvas.toDataURL('image/jpeg', .72);
        } catch { thumbnail = undefined; }
      } else if (kind === 'audio') {
        const audio = document.createElement('audio');
        audio.preload = 'metadata'; audio.src = url;
        await waitFor(audio, 'loadedmetadata');
        duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      } else {
        const image = new Image(); image.src = url;
        await waitFor(image, 'load');
        width = image.naturalWidth; height = image.naturalHeight; thumbnail = url;
      }
      return { id, name: file.name, kind, mimeType: file.type, size: file.size, duration, width, height, thumbnail, url, createdAt: new Date().toISOString() };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function scheduleSave() {
    state.saveStatus = 'saving';
    renderSaveStatus();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(state.project)));
      state.saveStatus = 'saved'; renderSaveStatus();
    }, 450);
  }

  function syncReframeDraftWithProject() {
    if (!state.reframe.assetId || !state.reframe.keyframes.length) return;
    const asset = state.project.assets.find((item) => item.id === state.reframe.assetId);
    if (!asset) {
      clearReframeProposal();
      return;
    }
    const applied = Boolean(asset.reframe?.enabled)
      || state.project.clips.some((clip) => clip.assetId === asset.id && clip.reframe?.enabled);
    state.reframe.status = applied ? 'applied' : 'completed';
    state.reframe.message = applied
      ? `${asset.name}에 자동 리프레임이 적용되어 있습니다.`
      : '리프레임 적용이 실행 취소되었습니다. 보정한 키프레임은 다시 적용할 수 있습니다.';
    persistReframeDraft();
  }

  function commit(mutator) {
    state.past.push(clone(state.project));
    if (state.past.length > MAX_HISTORY) state.past.shift();
    state.future = [];
    state.project = recalculate(mutator(clone(state.project)));
    if (!state.shortform.applying) invalidateShortformReview('타임라인이 변경되었습니다. 숏폼 후보를 다시 생성하세요.');
    state.playhead = clamp(state.playhead, 0, state.project.duration);
    scheduleSave();
    renderAll();
  }

  function undo() {
    if (!state.past.length) return;
    state.future.unshift(clone(state.project));
    state.project = state.past.pop();
    invalidateShortformReview('실행 취소로 타임라인이 변경되었습니다. 후보를 다시 생성하세요.');
    syncReframeDraftWithProject();
    scheduleSave(); renderAll();
  }

  function redo() {
    if (!state.future.length) return;
    state.past.push(clone(state.project));
    state.project = state.future.shift();
    invalidateShortformReview('다시 실행으로 타임라인이 변경되었습니다. 후보를 다시 생성하세요.');
    syncReframeDraftWithProject();
    scheduleSave(); renderAll();
  }

  function currentClip(track, time = state.playhead) {
    return state.project.clips.find((clip) => clip.trackId === track && time >= clip.timelineStart && time < clip.timelineStart + clipDuration(clip));
  }

  function mountApp() {
    document.getElementById('root').innerHTML = `
      <main class="app-shell">
        <header class="editor-toolbar">
          <div class="brand-lockup"><div class="brand-mark">S</div><div><strong>Shortform Studio</strong><span>AI 숏폼 편집기</span></div></div>
          <div class="project-title-wrap"><input id="projectTitle" aria-label="프로젝트 제목"><button id="saveIndicator" class="save-indicator" type="button"><span></span><em>저장됨</em></button></div>
          <div class="toolbar-actions">
            <div class="tool-group history-tools"><button id="undoButton" class="icon-button" title="실행 취소" aria-label="실행 취소">↶</button><button id="redoButton" class="icon-button" title="다시 실행" aria-label="다시 실행">↷</button></div>
            <button id="addTextButton" class="button quick-tool" title="텍스트 추가"><span>T</span><em>텍스트</em></button>
            <div class="app-menu-wrap">
              <button id="appMenuButton" class="button menu-button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="appMenu"><span>☰</span><em>메뉴</em></button>
              <div id="appMenu" class="app-menu" role="menu" hidden>
                <div class="menu-heading">프로젝트</div>
                <button role="menuitem" data-menu-action="import-media"><span>＋</span><div><strong>미디어 가져오기</strong><small>영상·오디오·이미지</small></div></button>
                <button role="menuitem" data-menu-action="import-captions"><span>CC</span><div><strong>자막 가져오기</strong><small>SRT · WebVTT</small></div></button>
                <button role="menuitem" data-menu-action="download-app"><span>↓</span><div><strong>앱 파일 저장</strong><small>독립 실행형 HTML</small></div></button>
                <button role="menuitem" data-menu-action="export-json"><span>{ }</span><div><strong>프로젝트 JSON</strong><small>편집 데이터 백업</small></div></button>
                <div class="menu-heading">편집</div>
                <div class="menu-inline"><button role="menuitem" data-menu-action="undo">실행 취소</button><button role="menuitem" data-menu-action="redo">다시 실행</button></div>
                <div class="menu-inline"><button role="menuitem" data-menu-action="split">분할</button><button role="menuitem" data-menu-action="delete">삭제</button></div>
                <div class="menu-heading">보기</div>
                <button role="menuitemcheckbox" data-menu-action="toggle-library"><span>◫</span><div><strong>미디어 패널</strong><small>왼쪽 패널 표시/숨김</small></div><b data-menu-check="library">✓</b></button>
                <button role="menuitemcheckbox" data-menu-action="toggle-inspector"><span>◧</span><div><strong>속성 패널</strong><small>오른쪽 패널 표시/숨김</small></div><b data-menu-check="inspector">✓</b></button>
                <button role="menuitemcheckbox" data-menu-action="toggle-timeline"><span>▤</span><div><strong>타임라인</strong><small>하단 패널 표시/숨김</small></div><b data-menu-check="timeline">✓</b></button>
              </div>
            </div>
            <button id="settingsButton" class="button settings-button" type="button" title="편집기 설정"><span>⚙</span><em>설정</em></button>
            <button id="exportButton" class="button primary export-button">내보내기 <span>↗</span></button>
          </div>
        </header>
        <div class="workspace">
          <aside class="media-library panel">
            <div class="panel-heading"><div><span class="eyebrow">LIBRARY</span><h2>미디어</h2></div><span id="assetCount" class="count-badge">0</span></div>
            <input id="fileInput" type="file" multiple accept="video/*,audio/*,image/*" hidden>
            <input id="captionInput" type="file" accept=".srt,.vtt,application/x-subrip,text/vtt" hidden>
            <div id="dropZone" class="drop-zone"><div class="upload-icon">＋</div><strong>미디어 추가</strong><span>파일을 끌어 놓거나 선택하세요</span><button id="pickFiles" class="button subtle" type="button">파일 선택</button></div>
            <p id="mediaError" class="inline-error" hidden></p><div id="assetList" class="asset-list"></div>
          </aside>
          <div class="layout-resizer vertical library-resizer" data-resize="libraryWidth" role="separator" aria-label="미디어 패널 너비 조절" aria-orientation="vertical" aria-valuemin="180" aria-valuemax="420" tabindex="0"></div>
          <section class="preview-section">
            <div id="previewStage" class="preview-stage"><div id="canvasFrame" class="canvas-frame"><div id="mediaHost"></div><div id="reframeBadge" class="reframe-badge" hidden></div><div id="textLayer"></div><div class="safe-zone"></div></div></div>
            <div class="playback-controls"><button id="backButton">−1s</button><button id="playButton" class="play-button">▶</button><button id="forwardButton">+1s</button><span class="timecode"><strong id="currentTime">00:00:00</strong><i>/</i><span id="durationTime">00:30:00</span></span><span id="previewQuality" class="preview-quality">미리보기 · 9:16</span></div>
          </section>
          <div class="layout-resizer vertical inspector-resizer" data-resize="inspectorWidth" role="separator" aria-label="속성 패널 너비 조절" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="460" tabindex="0"></div>
          <aside class="inspector panel"><div class="panel-heading"><div><span class="eyebrow">INSPECTOR</span><h2>속성</h2></div></div><div id="inspectorContent" class="inspector-scroll"></div></aside>
        </div>
        <div class="layout-resizer horizontal timeline-resizer" data-resize="timelineHeight" role="separator" aria-label="타임라인 높이 조절" aria-orientation="horizontal" aria-valuemin="150" aria-valuemax="520" tabindex="0"></div>
        <section class="timeline-section"><div class="timeline-toolbar"><div><strong>타임라인</strong><span id="elementCount">0개 요소</span></div><div class="zoom-control"><span>−</span><input id="zoomInput" type="range" min="8" max="60" value="18" aria-label="타임라인 확대"><span>＋</span></div></div><div id="timelineScroll" class="timeline-scroll"><div id="timelineContent" class="timeline-content"></div></div></section>
        <div id="modalRoot"></div>
      </main>`;
    document.querySelectorAll('.layout-resizer').forEach(bindLayoutResizer);
    bindEvents();
    applyUiPreferences();
  }

  function renderSaveStatus() {
    const button = document.getElementById('saveIndicator');
    if (!button) return;
    button.querySelector('span').className = state.saveStatus === 'saving' ? 'saving' : '';
    button.querySelector('em').textContent = state.saveStatus === 'loading' ? '불러오는 중' : state.saveStatus === 'saving' ? '저장 중' : '저장됨';
  }

  function renderToolbar() {
    const title = document.getElementById('projectTitle');
    if (title !== document.activeElement) title.value = state.project.title;
    document.getElementById('undoButton').disabled = !state.past.length;
    document.getElementById('redoButton').disabled = !state.future.length;
    const undoAction = document.querySelector('[data-menu-action="undo"]');
    const redoAction = document.querySelector('[data-menu-action="redo"]');
    const splitAction = document.querySelector('[data-menu-action="split"]');
    const deleteAction = document.querySelector('[data-menu-action="delete"]');
    if (undoAction) undoAction.disabled = !state.past.length;
    if (redoAction) redoAction.disabled = !state.future.length;
    if (splitAction) splitAction.disabled = state.selection?.kind !== 'clip';
    if (deleteAction) deleteAction.disabled = !state.selection;
    const checks = {
      library: state.ui.libraryVisible,
      inspector: state.ui.inspectorVisible,
      timeline: state.ui.timelineVisible,
    };
    Object.entries(checks).forEach(([key, visible]) => {
      const check = document.querySelector(`[data-menu-check="${key}"]`);
      if (check) check.hidden = !visible;
      check?.closest('[role="menuitemcheckbox"]')?.setAttribute('aria-checked', String(visible));
    });
    const exportButton = document.getElementById('exportButton');
    exportButton.disabled = hasPendingReframe();
    exportButton.title = hasPendingReframe() ? '자동 리프레임 제안을 적용하거나 취소한 뒤 내보낼 수 있습니다.' : '';
    applyUiPreferences();
    renderSaveStatus();
  }

  function renderAssets() {
    document.getElementById('assetCount').textContent = state.project.assets.length;
    const list = document.getElementById('assetList');
    if (!state.project.assets.length) {
      list.innerHTML = '<div class="empty-state"><span>아직 미디어가 없습니다.</span><small>MP4, WebM, MP3, JPG, PNG 지원</small></div>';
      return;
    }
    list.innerHTML = state.project.assets.map((asset) => `
      <article class="asset-card ${state.selection?.kind === 'asset' && state.selection.id === asset.id ? 'is-selected' : ''}" data-select-asset="${asset.id}">
        <div class="asset-thumb ${asset.kind}" ${asset.thumbnail ? `style="background-image:url('${asset.thumbnail}')"` : ''}>
          ${asset.thumbnail ? '' : `<span>${asset.kind === 'audio' ? '♪' : asset.kind === 'image' ? '▧' : '▶'}</span>`}<em>${asset.kind.toUpperCase()}</em>
        </div><div class="asset-info"><strong title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</strong><span>${formatTime(asset.duration)} · ${formatSize(asset.size)}</span>
        <div class="asset-actions"><button data-add-asset="${asset.id}">+ 타임라인</button><button class="danger-text" data-remove-asset="${asset.id}">삭제</button></div></div>
      </article>`).join('');
  }

  function hasPendingReframe() {
    return state.reframe.analyzing || (state.reframe.keyframes.length > 0 && state.reframe.status !== 'applied');
  }

  function previewCanvasConfig() {
    return state.reframe.keyframes.length && state.reframe.status !== 'applied'
      ? { ratio: '9:16', ...ratios['9:16'], background: state.project.canvas.background }
      : state.project.canvas;
  }

  function activeReframeForClip(clip) {
    if (!clip) return null;
    if (state.reframe.assetId === clip.assetId && state.reframe.keyframes.length && state.reframe.status !== 'applied') {
      return {
        enabled: true, targetRatio: '9:16', keyframes: state.reframe.keyframes,
        method: state.reframe.method, draft: true,
      };
    }
    return clip.reframe?.enabled ? clip.reframe : null;
  }

  function focusAtSourceTime(reframe, sourceTime) {
    const keyframes = reframe?.keyframes || [];
    if (!keyframes.length) return { x: 0.5, y: 0.5 };
    if (sourceTime <= keyframes[0].time) return keyframes[0];
    const last = keyframes.at(-1);
    if (sourceTime >= last.time) return last;
    const nextIndex = keyframes.findIndex((keyframe) => keyframe.time >= sourceTime);
    const previous = keyframes[nextIndex - 1];
    const next = keyframes[nextIndex];
    const progress = (sourceTime - previous.time) / Math.max(0.001, next.time - previous.time);
    return {
      x: previous.x + (next.x - previous.x) * progress,
      y: previous.y + (next.y - previous.y) * progress,
    };
  }

  function objectPositionForFocus(sourceWidth, sourceHeight, targetWidth, targetHeight, focus) {
    const sourceRatio = sourceWidth / Math.max(1, sourceHeight);
    const targetRatio = targetWidth / Math.max(1, targetHeight);
    let x = 50;
    let y = 50;
    if (sourceRatio > targetRatio) {
      const visibleFraction = targetRatio / sourceRatio;
      x = clamp((focus.x - visibleFraction / 2) / Math.max(0.001, 1 - visibleFraction), 0, 1) * 100;
    } else if (sourceRatio < targetRatio) {
      const visibleFraction = sourceRatio / targetRatio;
      y = clamp((focus.y - visibleFraction / 2) / Math.max(0.001, 1 - visibleFraction), 0, 1) * 100;
    }
    return `${x.toFixed(2)}% ${y.toFixed(2)}%`;
  }

  function updatePreviewReframe() {
    const clip = currentClip('video');
    const asset = clip && state.project.assets.find((item) => item.id === clip.assetId);
    const reframe = activeReframeForClip(clip);
    const visual = state.previewVisual;
    const badge = document.getElementById('reframeBadge');
    if (visual instanceof HTMLVideoElement && clip && asset && reframe) {
      const sourceTime = clipSourceTime(clip, state.playhead);
      const focus = focusAtSourceTime(reframe, sourceTime);
      const previewCanvas = previewCanvasConfig();
      visual.style.objectPosition = objectPositionForFocus(
        asset.width || visual.videoWidth, asset.height || visual.videoHeight,
        previewCanvas.width, previewCanvas.height, focus,
      );
      if (badge) {
        badge.hidden = false;
        badge.textContent = reframe.draft ? 'AUTO REFRAME · 미리보기' : 'AUTO REFRAME';
      }
    } else {
      if (visual) visual.style.objectPosition = '50% 50%';
      if (badge) badge.hidden = true;
    }
  }

  function syncPreview(force = false) {
    const previewCanvas = previewCanvasConfig();
    const frame = document.getElementById('canvasFrame');
    frame.style.aspectRatio = `${previewCanvas.width} / ${previewCanvas.height}`;
    frame.style.background = previewCanvas.background;
    document.getElementById('previewQuality').textContent = `미리보기 · ${previewCanvas.ratio}${hasPendingReframe() ? ' · 리프레임 검토' : ''}`;
    const clip = currentClip('video');
    const asset = clip && state.project.assets.find((item) => item.id === clip.assetId);
    const host = document.getElementById('mediaHost');
    if (force || state.activeVisualId !== clip?.id) {
      if (state.previewVisual instanceof HTMLVideoElement) state.previewVisual.pause();
      host.innerHTML = '';
      state.previewVisual = null; state.activeVisualId = clip?.id || '';
      if (!clip || !asset?.url) {
        host.innerHTML = '<div class="canvas-empty"><div class="canvas-empty-icon">▶</div><strong>미디어를 추가하세요</strong><span>좌측에서 영상이나 이미지를 업로드하면<br>타임라인에 자동으로 배치됩니다.</span></div>';
      } else if (asset.kind === 'image') {
        const image = new Image(); image.className = 'preview-media'; image.src = asset.url; image.alt = asset.name;
        host.append(image); state.previewVisual = image;
      } else {
        const video = document.createElement('video');
        video.className = 'preview-media'; video.src = asset.url; video.playsInline = true; video.preload = 'auto';
        video.volume = clipVolume(clip, state.playhead); video.playbackRate = clip.speed || 1; video.currentTime = Math.max(0, clipSourceTime(clip, state.playhead));
        host.append(video); state.previewVisual = video;
        if (state.playing) void video.play().catch(() => { state.playing = false; renderPlayback(); });
      }
    } else if (clip && state.previewVisual instanceof HTMLVideoElement && !state.playing) {
      const expected = clipSourceTime(clip, state.playhead);
      if (Math.abs(state.previewVisual.currentTime - expected) > .08) state.previewVisual.currentTime = Math.max(0, expected);
    }

    const audioClip = currentClip('audio');
    const audioAsset = audioClip && state.project.assets.find((item) => item.id === audioClip.assetId);
    if (force || state.activeAudioId !== audioClip?.id) {
      state.previewAudio?.pause(); state.previewAudio = null; state.activeAudioId = audioClip?.id || '';
      if (audioClip && audioAsset?.url) {
        const audio = new Audio(audioAsset.url); audio.volume = audioClip.volume;
        audio.currentTime = Math.max(0, audioClip.sourceStart + state.playhead - audioClip.timelineStart);
        state.previewAudio = audio;
        if (state.previewVisual instanceof HTMLVideoElement) state.previewVisual.muted = true;
        if (state.playing) void audio.play();
      }
    }
    updatePreviewReframe();
    renderPreviewTexts(); renderPlayback();
  }

  function renderPreviewTexts() {
    document.getElementById('textLayer').innerHTML = state.project.texts
      .filter((text) => state.playhead >= text.start && state.playhead <= text.end)
      .map((text) => {
        const kf = (text.keyframes && text.keyframes.length) ? interpolateTextKeyframes(text, state.playhead) : { x: text.x, y: text.y, fontSize: text.fontSize, opacity: text.opacity ?? 1 };
        return `<div class="preview-text" data-select-text="${text.id}" style="left:${kf.x}%;top:${kf.y}%;width:${text.boxWidth || 88}%;color:${text.color};background:${text.background};font-size:${Math.max(12, kf.fontSize / 3.2)}px;font-weight:${text.fontWeight};font-family:${text.fontFamily || 'sans-serif'};text-align:${text.align};opacity:${kf.opacity}">${escapeHtml(text.text).replaceAll('\n', '<br>')}</div>`;
      }).join('');
  }

  function renderPlayback() {
    document.getElementById('playButton').textContent = state.playing ? 'Ⅱ' : '▶';
    document.getElementById('currentTime').textContent = formatTime(state.playhead, true);
    document.getElementById('durationTime').textContent = formatTime(state.project.duration, true);
    const line = document.querySelector('.playhead');
    if (line) line.style.left = `${LABEL_WIDTH + state.playhead * state.zoom}px`;
  }

  function togglePlayback() {
    if (state.playhead >= state.project.duration - .02) state.playhead = 0;
    state.playing = !state.playing;
    state.lastFrameAt = performance.now();
    syncPreview(true);
    if (state.playing) state.animation = requestAnimationFrame(animate);
    else { cancelAnimationFrame(state.animation); state.previewVisual?.pause?.(); state.previewAudio?.pause?.(); }
    renderPlayback();
  }

  function animate(timestamp) {
    if (!state.playing) return;
    const previousVisualId = currentClip('video')?.id;
    const previousAudioId = currentClip('audio')?.id;
    const delta = Math.min(.1, (timestamp - state.lastFrameAt) / 1000);
    const playbackEnd = state.shortform.previewEnd || state.project.duration;
    state.lastFrameAt = timestamp;
    state.playhead = Math.min(playbackEnd, state.playhead + delta);
    if (currentClip('video')?.id !== previousVisualId || currentClip('audio')?.id !== previousAudioId) syncPreview(true);
    else { updatePreviewReframe(); renderPreviewTexts(); renderPlayback(); }
    if (state.playhead >= playbackEnd) {
      state.playing = false;
      state.shortform.previewEnd = 0;
      state.previewVisual?.pause?.(); state.previewAudio?.pause?.(); renderPlayback();
      return;
    }
    state.animation = requestAnimationFrame(animate);
  }

  function seek(time, preserveShortformPreview = false) {
    if (!preserveShortformPreview) state.shortform.previewEnd = 0;
    state.playhead = clamp(time, 0, state.project.duration);
    syncPreview(true); renderPlayback();
  }

  function stopPlayback(clearShortformPreview = true) {
    state.playing = false;
    cancelAnimationFrame(state.animation);
    state.previewVisual?.pause?.();
    state.previewAudio?.pause?.();
    if (clearShortformPreview) state.shortform.previewEnd = 0;
    renderPlayback();
  }

  function cancelLlmRequest() {
    state.llm.controller?.abort();
    state.llm.controller = null;
  }

  function updateLlmPreference(enabled) {
    state.llm.semanticAssist = Boolean(enabled);
    if (!state.llm.semanticAssist) cancelLlmRequest();
    try {
      localStorage.setItem(LLM_PREFERENCE_KEY, JSON.stringify({ semanticAssist: state.llm.semanticAssist }));
    } catch {
      state.llm.message = `${state.llm.message} 설정 저장은 사용할 수 없습니다.`;
    }
    renderInspector();
  }

  function refreshLlmHealth() {
    if (llmHealthPromise) return llmHealthPromise;
    const request = (async () => {
      state.llm.healthStatus = 'checking';
      state.llm.message = 'LLM 서버 상태를 확인하고 있습니다.';
      if (document.getElementById('inspectorContent')) renderInspector();
      if (location.protocol === 'file:') {
        state.llm = {
          ...state.llm, healthStatus: 'unavailable', configured: false, available: false,
          provider: '', model: '', demo: false, reasonCode: 'server-unavailable',
          configurationSource: 'server-environment', restartRequired: false, persistent: true,
          message: '단일 HTML에서는 서버 LLM을 사용할 수 없습니다.',
        };
        renderInspector();
        return;
      }
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch('/api/llm/health', {
          headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('health unavailable');
        const health = await response.json();
        const available = health?.available === true;
        state.llm = {
          ...state.llm,
          healthStatus: available ? 'available' : 'unavailable',
          configured: health?.configured === true,
          available,
          provider: String(health?.provider || '').slice(0, 80),
          model: String(health?.model || '').slice(0, 160),
          demo: health?.demo === true,
          reasonCode: String(health?.reasonCode || '').slice(0, 80),
          configurationSource: ['server-environment', 'browser-runtime'].includes(health?.configurationSource)
            ? health.configurationSource
            : '',
          restartRequired: health?.restartRequired === true,
          persistent: health?.persistent !== false,
          message: available
            ? `${health.provider}${health.model ? ` · ${health.model}` : ''} 연결됨${health.demo ? ' · DEMO' : ''}`
            : '서버에 LLM Provider가 설정되지 않았습니다.',
        };
      } catch {
        state.llm = {
          ...state.llm, healthStatus: 'error', configured: false, available: false,
          provider: '', model: '', demo: false, reasonCode: 'server-unavailable',
          configurationSource: 'server-environment', restartRequired: false, persistent: true,
          message: 'LLM 서버 상태를 확인할 수 없습니다.',
        };
      } finally {
        clearTimeout(timeout);
      }
      renderInspector();
    })();
    llmHealthPromise = request;
    return request.finally(() => {
      if (llmHealthPromise === request) llmHealthPromise = null;
    });
  }

  function invalidateShortformReview(message) {
    cancelLlmRequest();
    const review = state.shortform;
    if (!review.analyzing && !review.candidates.length && review.status !== 'applied') return;
    stopPlayback();
    state.shortform = {
      ...review, analyzing: false, applying: false, status: 'idle', progress: 0, message,
      assetId: '', candidates: [], selectedId: '', sceneCuts: [], previewEnd: 0,
      analysisVersion: review.analysisVersion + 1,
    };
  }

  function getShortformAsset() {
    if (state.selection?.kind === 'asset') {
      const selected = state.project.assets.find((asset) => asset.id === state.selection.id);
      if (selected?.kind === 'video') return selected;
    }
    if (state.selection?.kind === 'clip') {
      const clip = state.project.clips.find((item) => item.id === state.selection.id && item.trackId === 'video');
      const selected = clip && state.project.assets.find((asset) => asset.id === clip.assetId);
      if (selected?.kind === 'video') return selected;
    }
    return state.project.assets.find((asset) => asset.kind === 'video');
  }

  function shortformTimelineRanges(assetId) {
    return mergeTimeRanges(state.project.clips
      .filter((clip) => clip.assetId === assetId && clip.trackId === 'video')
      .map((clip) => ({
        start: clip.timelineStart,
        end: clip.timelineStart + clip.sourceEnd - clip.sourceStart,
      })));
  }

  function mapSourcePointsToTimeline(assetId, points) {
    const mapped = state.project.clips
      .filter((clip) => clip.assetId === assetId && clip.trackId === 'video')
      .flatMap((clip) => points.flatMap((point) => {
        if (point.time < clip.sourceStart || point.time >= clip.sourceEnd) return [];
        return [{ ...point, time: clip.timelineStart + point.time - clip.sourceStart }];
      }))
      .sort((first, second) => first.time - second.time);
    return mapped.filter((point, index) => !index || point.time - mapped[index - 1].time > 0.2
      || point.strength > mapped[index - 1].strength);
  }

  function shortformTranscriptSignals(assetId) {
    const clips = state.project.clips.filter((clip) => clip.assetId === assetId && clip.trackId === 'video');
    if (state.sttProposal?.assetId === assetId && state.sttProposal.segments.length) {
      const cues = clips.flatMap((clip) => state.sttProposal.segments.flatMap((segment) => {
        const sourceStart = Math.max(clip.sourceStart, segment.start);
        const sourceEnd = Math.min(clip.sourceEnd, segment.end);
        if (sourceEnd - sourceStart <= 0.03) return [];
        return [{
          start: clip.timelineStart + sourceStart - clip.sourceStart,
          end: clip.timelineStart + sourceEnd - clip.sourceStart,
          text: String(segment.text || '').trim(), confidence: segment.confidence,
          speaker: segment.speaker, source: 'stt',
          complete: segment.start >= clip.sourceStart - 0.04 && segment.end <= clip.sourceEnd + 0.04,
        }];
      }));
      const completeCues = cues
        .filter((cue) => cue.complete)
        .sort((first, second) => first.start - second.start);
      if (completeCues.length) return { source: 'stt', label: 'STT 발화', cues: completeCues };
    }
    const coverage = shortformTimelineRanges(assetId);
    const cues = state.project.texts
      .filter((text) => text.role === 'caption')
      .flatMap((text) => coverage.flatMap((range) => {
        const start = Math.max(text.start, range.start);
        const end = Math.min(text.end, range.end);
        return end - start > 0.03 ? [{
          start, end, text: String(text.text || '').trim(), confidence: text.confidence,
          speaker: text.speaker, source: 'captions',
        }] : [];
      }))
      .sort((first, second) => first.start - second.start);
    const unique = cues.filter((cue, index) => !index
      || Math.abs(cue.start - cues[index - 1].start) > 0.02
      || Math.abs(cue.end - cues[index - 1].end) > 0.02
      || cue.text !== cues[index - 1].text);
    return { source: unique.length ? 'captions' : 'visual', label: unique.length ? '타임라인 자막' : '장면 중심', cues: unique };
  }

  function shortformSilenceRanges(assetId) {
    if (state.silence.assetId !== assetId || !state.silence.candidates.length) return [];
    const sourceRanges = state.silence.candidates.map((candidate) => ({ start: candidate.start, end: candidate.end }));
    return mergeTimeRanges(state.project.clips
      .filter((clip) => clip.assetId === assetId && clip.trackId === 'video')
      .flatMap((clip) => sourceRanges.flatMap((range) => {
        const sourceStart = Math.max(clip.sourceStart, range.start);
        const sourceEnd = Math.min(clip.sourceEnd, range.end);
        if (sourceEnd - sourceStart <= 0.03) return [];
        return [{
          start: clip.timelineStart + sourceStart - clip.sourceStart,
          end: clip.timelineStart + sourceEnd - clip.sourceStart,
        }];
      })));
  }

  function frameColorSignature(context, width, height) {
    const { data } = context.getImageData(0, 0, width, height);
    const columns = 4;
    const rows = 3;
    const totals = new Array(columns * rows * 3).fill(0);
    const counts = new Array(columns * rows).fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = (y * width + x) * 4;
        const cellX = Math.min(columns - 1, Math.floor(x / width * columns));
        const cellY = Math.min(rows - 1, Math.floor(y / height * rows));
        const cell = cellY * columns + cellX;
        totals[cell * 3] += data[pixel];
        totals[cell * 3 + 1] += data[pixel + 1];
        totals[cell * 3 + 2] += data[pixel + 2];
        counts[cell] += 1;
      }
    }
    return totals.map((total, index) => total / Math.max(1, counts[Math.floor(index / 3)]) / 255);
  }

  function signatureDifference(first, second) {
    if (!first || !second || first.length !== second.length) return 0;
    return first.reduce((total, value, index) => total + Math.abs(value - second[index]), 0) / first.length;
  }

  function shortformAbortError() {
    const error = new Error('숏폼 후보 분석이 취소되었습니다.');
    error.name = 'AbortError';
    return error;
  }

  function shortformAwait(promise, analysisVersion, timeout = 15000) {
    if (state.shortform.analysisVersion !== analysisVersion) return Promise.reject(shortformAbortError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearInterval(cancelTimer);
        clearTimeout(timeoutTimer);
        callback(value);
      };
      const cancelTimer = window.setInterval(() => {
        if (state.shortform.analysisVersion !== analysisVersion) finish(reject, shortformAbortError());
      }, 40);
      const timeoutTimer = window.setTimeout(() => {
        finish(reject, new Error('장면 분석 미디어 준비 시간이 초과되었습니다.'));
      }, timeout);
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (reason) => finish(reject, reason),
      );
    });
  }

  async function analyzeShortformScenes(asset, analysisVersion) {
    const blob = await shortformAwait(loadBlob(asset.id), analysisVersion, 10000);
    if (!blob) throw new Error('원본 영상이 없어 장면 분석을 건너뜁니다.');
    const objectUrl = URL.createObjectURL(blob);
    try {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = objectUrl;
      await shortformAwait(waitFor(video, 'loadeddata'), analysisVersion, 15000);
      const duration = Math.max(0.1, Number.isFinite(video.duration) ? video.duration : asset.duration);
      const interval = Math.max(1.5, duration / 120);
      const times = [];
      for (let time = 0; time < duration; time += interval) times.push(Math.min(time, duration - 0.04));
      if (duration - (times.at(-1) || 0) > interval * 0.4) times.push(Math.max(0, duration - 0.04));
      const canvas = document.createElement('canvas');
      canvas.width = 48; canvas.height = 27;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const samples = [];
      let previousSignature = null;
      for (let index = 0; index < times.length; index += 1) {
        if (state.shortform.analysisVersion !== analysisVersion) throw shortformAbortError();
        await shortformAwait(seekVideoFrame(video, times[index]), analysisVersion, 13000);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const signature = frameColorSignature(context, canvas.width, canvas.height);
        samples.push({ time: times[index], difference: signatureDifference(previousSignature, signature) });
        previousSignature = signature;
        if (index % 4 === 0 || index === times.length - 1) {
          state.shortform.progress = 0.08 + ((index + 1) / times.length) * 0.72;
          state.shortform.message = `장면 변화 ${index + 1}/${times.length} 프레임 분석 중`;
          renderInspector();
          await waitForAnalysisTurn();
        }
      }
      const differences = samples.slice(1).map((sample) => sample.difference);
      const average = differences.reduce((total, value) => total + value, 0) / Math.max(1, differences.length);
      const variance = differences.reduce((total, value) => total + (value - average) ** 2, 0) / Math.max(1, differences.length);
      const threshold = clamp(average + Math.sqrt(variance) * 1.15, 0.085, 0.26);
      return samples.filter((sample, index) => index > 0
        && sample.difference >= threshold
        && sample.difference >= (samples[index - 1]?.difference || 0)
        && sample.difference >= (samples[index + 1]?.difference || 0))
        .map((sample) => ({ time: sample.time, strength: clamp(sample.difference / Math.max(0.01, threshold), 0, 2) }));
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function nearestShortformBoundary(time, boundaries, minimum, maximum, tolerance = 2) {
    const nearby = boundaries
      .filter((boundary) => boundary >= minimum && boundary <= maximum && Math.abs(boundary - time) <= tolerance)
      .sort((first, second) => Math.abs(first - time) - Math.abs(second - time));
    return nearby[0] ?? clamp(time, minimum, maximum);
  }

  function generateShortformCandidates(assetId, transcript, sceneCuts, silences, targetDuration) {
    const coverage = shortformTimelineRanges(assetId);
    if (!coverage.length) return [];
    const minimumDuration = Math.max(15, targetDuration - 12);
    const maximumDuration = Math.min(60, targetDuration + 18);
    const hookPattern = /[?？]|\d|핵심|방법|이유|결론|중요|비밀|문제|결과|하지만|절대|처음|best|how|why|secret/i;
    const cueStarts = transcript.cues.map((cue) => cue.start);
    const sceneTimes = sceneCuts.map((cut) => cut.time);
    const silenceStarts = silences.map((silence) => silence.start);
    const silenceEnds = silences.map((silence) => silence.end);
    const startBoundaries = [...coverage.map((range) => range.start), ...cueStarts, ...sceneTimes, ...silenceEnds];
    const endBoundaries = [...coverage.map((range) => range.end), ...transcript.cues.map((cue) => cue.end), ...sceneTimes, ...silenceStarts];
    const starts = [];
    for (const range of coverage) {
      starts.push(range.start);
      for (let time = range.start + targetDuration * 0.72; time < range.end - minimumDuration; time += targetDuration * 0.72) starts.push(time);
    }
    transcript.cues.forEach((cue, index) => {
      const previous = transcript.cues[index - 1];
      if (!previous || cue.start - previous.end >= 1.1 || hookPattern.test(cue.text)) starts.push(cue.start);
    });
    starts.push(...sceneTimes, ...silenceEnds);
    const uniqueStarts = starts.sort((first, second) => first - second)
      .filter((time, index, values) => !index || time - values[index - 1] > 0.8);
    const proposals = uniqueStarts.flatMap((rawStart) => {
      const range = coverage.find((item) => rawStart >= item.start - 0.02 && rawStart < item.end - 0.02);
      if (!range) return [];
      const start = nearestShortformBoundary(rawStart, startBoundaries, range.start, Math.max(range.start, range.end - minimumDuration), 1.8);
      const minimumEnd = start + minimumDuration;
      const maximumEnd = Math.min(range.end, start + maximumDuration);
      if (maximumEnd - minimumEnd < -0.02) return [];
      const desiredEnd = Math.min(maximumEnd, start + targetDuration);
      const validEnds = endBoundaries.filter((time) => time >= minimumEnd && time <= maximumEnd);
      let end = validEnds.sort((first, second) => Math.abs(first - desiredEnd) - Math.abs(second - desiredEnd))[0] || desiredEnd;
      end = nearestShortformBoundary(end, endBoundaries, minimumEnd, maximumEnd, 2.2);
      if (end - start < minimumDuration - 0.03) return [];
      const duration = end - start;
      const overlappingCues = transcript.cues.filter((cue) => cue.end > start && cue.start < end);
      const cues = overlappingCues.filter((cue) => cue.start >= start - 0.04
        && cue.end <= end + 0.04
        && cue.complete !== false);
      const speechRanges = mergeTimeRanges(overlappingCues.map((cue) => ({ start: Math.max(start, cue.start), end: Math.min(end, cue.end) })));
      const speechDuration = speechRanges.reduce((total, rangeItem) => total + rangeItem.end - rangeItem.start, 0);
      const speechDensity = speechDuration / Math.max(0.1, duration);
      const openingText = cues.filter((cue) => cue.start < start + 6).map((cue) => cue.text).join(' ');
      const hookScore = hookPattern.test(openingText) ? 1 : 0;
      const confidenceValues = cues.map((cue) => Number(cue.confidence)).filter(Number.isFinite);
      const confidence = confidenceValues.length
        ? confidenceValues.reduce((total, value) => total + value, 0) / confidenceValues.length
        : cues.length ? 0.72 : 0.35;
      const lengthScore = 1 - Math.min(1, Math.abs(duration - targetDuration) / Math.max(1, targetDuration));
      const startsClean = Math.abs(start - range.start) < 0.2 || cueStarts.some((time) => Math.abs(time - start) < 0.3)
        || sceneTimes.some((time) => Math.abs(time - start) < 0.8)
        || silenceEnds.some((time) => Math.abs(time - start) < 0.8);
      const endsClean = Math.abs(end - range.end) < 0.2 || transcript.cues.some((cue) => Math.abs(cue.end - end) < 0.3)
        || sceneTimes.some((time) => Math.abs(time - end) < 0.8)
        || silenceStarts.some((time) => Math.abs(time - end) < 0.8);
      const boundaryScore = (Number(startsClean) + Number(endsClean)) / 2;
      const sceneCount = sceneTimes.filter((time) => time > start && time < end).length;
      const completeSentence = /[.!?。！？]$/.test(cues.at(-1)?.text || '') ? 1 : 0;
      const score = clamp(Math.round(
        (cues.length ? speechDensity * 30 + hookScore * 18 + confidence * 10 : 24)
        + lengthScore * 17 + boundaryScore * 12 + Math.min(1, sceneCount / 3) * 8 + completeSentence * 5
      ), 0, 100);
      const firstText = cues.find((cue) => cue.text)?.text.replace(/\s+/g, ' ').trim();
      const tokens = [...new Set(cues.flatMap((cue) => cue.text.toLowerCase().split(/[^\p{L}\p{N}]+/u))
        .filter((token) => token.length >= 2))];
      const title = firstText
        ? `${firstText.slice(0, 44)}${firstText.length > 44 ? '…' : ''}`
        : `${formatTime(start)} 장면 하이라이트`;
      const reasons = [];
      if (hookScore) reasons.push('훅 문장');
      if (speechDensity >= 0.55) reasons.push('높은 발화 밀도');
      if (sceneCount) reasons.push(`장면 전환 ${sceneCount}회`);
      if (boundaryScore >= 0.5) reasons.push('자연스러운 경계');
      if (!reasons.length) reasons.push('목표 길이 적합');
      const signalSource = cues.length ? transcript.source : 'visual';
      const signalLabel = cues.length ? transcript.label : '장면 중심';
      return [{
        id: uid(), start, end, duration, score, title, reasons,
        signalSource, signalLabel, cues, tokens,
        sceneCount, speechDensity,
      }];
    });
    const selected = [];
    for (const candidate of proposals.sort((first, second) => second.score - first.score || first.start - second.start)) {
      const duplicatesExisting = selected.some((existing) => {
        const overlap = Math.max(0, Math.min(candidate.end, existing.end) - Math.max(candidate.start, existing.start));
        const temporalSimilarity = overlap / Math.min(candidate.duration, existing.duration);
        const firstTokens = new Set(candidate.tokens);
        const secondTokens = new Set(existing.tokens);
        const union = new Set([...firstTokens, ...secondTokens]);
        const sharedTokens = [...firstTokens].filter((token) => secondTokens.has(token)).length;
        const transcriptSimilarity = union.size ? sharedTokens / union.size : 0;
        return temporalSimilarity > 0.58 || (candidate.tokens.length >= 4 && transcriptSimilarity > 0.88);
      });
      if (!duplicatesExisting) selected.push(candidate);
      if (selected.length === 6) break;
    }
    return selected.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  function renderShortformState(patch) {
    state.shortform = { ...state.shortform, ...patch };
    renderInspector();
  }

  async function enrichShortformCandidates(candidates, analysisVersion) {
    if (state.llm.semanticAssist && state.llm.healthStatus === 'checking') {
      await refreshLlmHealth();
      if (state.shortform.analysisVersion !== analysisVersion) throw shortformAbortError();
    }
    if (!state.llm.semanticAssist || !state.llm.available) {
      return {
        candidates,
        enhanced: false,
        warning: state.llm.semanticAssist && state.llm.healthStatus !== 'checking'
          ? ' LLM을 사용할 수 없어 기본 점수를 유지했습니다.'
          : '',
      };
    }
    const controller = new AbortController();
    cancelLlmRequest();
    state.llm.controller = controller;
    renderShortformState({ progress: 0.92, message: 'LLM이 후보의 의미·제목·근거를 재평가하고 있습니다.' });
    try {
      const response = await fetch('/api/llm/shortform/rerank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          language: 'ko',
          targetDuration: state.shortform.targetDuration,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            score: candidate.score,
            start: candidate.start,
            end: candidate.end,
            title: candidate.title,
            reasons: candidate.reasons,
            transcriptExcerpt: candidate.cues.map((cue) => cue.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 700),
          })),
        }),
      });
      if (!response.ok) throw new Error(`LLM 요청 실패 (${response.status})`);
      const payload = await response.json();
      if (state.shortform.analysisVersion !== analysisVersion) throw shortformAbortError();
      if (!Array.isArray(payload?.candidates) || payload.candidates.length !== candidates.length) throw new Error('LLM 후보 수가 일치하지 않습니다.');
      const originals = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const seen = new Set();
      const enriched = payload.candidates.map((candidate, index) => {
        const original = originals.get(candidate?.id);
        const score = Number(candidate?.score);
        const semanticScore = Number(candidate?.semanticScore);
        const title = typeof candidate?.title === 'string' ? candidate.title.trim() : '';
        const summary = typeof candidate?.summary === 'string' ? candidate.summary.trim() : '';
        if (!original || seen.has(candidate.id) || !Number.isFinite(score) || score < 0 || score > 100
          || !Number.isFinite(semanticScore) || semanticScore < 0 || semanticScore > 100
          || !title || title.length > 80 || !summary || summary.length > 240
          || !Array.isArray(candidate.reasons) || !candidate.reasons.length || candidate.reasons.length > 4
          || candidate.reasons.some((reason) => typeof reason !== 'string' || !reason.trim() || reason.length > 80)) {
          throw new Error('LLM 후보 응답 형식이 올바르지 않습니다.');
        }
        seen.add(candidate.id);
        return {
          ...original,
          score: Math.round(score),
          deterministicScore: original.score,
          semanticScore: Math.round(semanticScore),
          title,
          summary,
          reasons: candidate.reasons.map((reason) => reason.trim()),
          aiEnhanced: true,
          aiProvider: String(payload.provider || '').slice(0, 80),
          aiModel: String(payload.model || '').slice(0, 160),
          rank: Number(candidate.rank) || index + 1,
        };
      });
      if (seen.size !== originals.size) throw new Error('LLM 후보 응답에 누락된 ID가 있습니다.');
      return { candidates: enriched, enhanced: true, warning: '' };
    } catch (reason) {
      if (state.shortform.analysisVersion !== analysisVersion) throw shortformAbortError();
      if (reason?.name === 'AbortError' && state.llm.semanticAssist) throw reason;
      return { candidates, enhanced: false, warning: ` LLM 보강에 실패해 기본 후보를 유지했습니다. (${reason instanceof Error ? reason.message : '알 수 없는 오류'})` };
    } finally {
      if (state.llm.controller === controller) state.llm.controller = null;
    }
  }

  async function analyzeShortformCandidates() {
    const asset = getShortformAsset();
    if (state.reframe.analyzing || hasPendingReframe() || state.silence.analyzing || state.sttJob.active) {
      renderShortformState({ status: 'failed', message: '진행 중이거나 검토 대기 중인 자동 자막, 리프레임 또는 침묵 분석을 먼저 완료하거나 취소하세요.' });
      return;
    }
    if (!asset) {
      renderShortformState({ status: 'failed', message: '숏폼 후보 생성에는 영상 파일이 필요합니다.' });
      return;
    }
    const coverage = shortformTimelineRanges(asset.id);
    if (!coverage.length) {
      renderShortformState({ status: 'failed', message: '선택한 영상이 타임라인에 없습니다.' });
      return;
    }
    const analysisVersion = state.shortform.analysisVersion + 1;
    renderShortformState({
      analyzing: true, status: 'analyzing', progress: 0.04, message: `${asset.name}의 발화와 장면을 준비하고 있습니다.`,
      assetId: asset.id, analysisVersion, candidates: [], selectedId: '', sceneCuts: [], previewEnd: 0,
    });
    const transcript = shortformTranscriptSignals(asset.id);
    let sceneSourceCuts = [];
    let sceneWarning = '';
    try {
      try {
        sceneSourceCuts = await analyzeShortformScenes(asset, analysisVersion);
      } catch (reason) {
        if (reason?.name === 'AbortError') throw reason;
        sceneWarning = reason instanceof Error ? reason.message : '장면 분석을 사용할 수 없습니다.';
      }
      if (state.shortform.analysisVersion !== analysisVersion) return;
      state.shortform.progress = 0.84;
      state.shortform.message = '발화·침묵·장면 신호를 점수화하고 있습니다.';
      renderInspector();
      await waitForAnalysisTurn();
      if (state.shortform.analysisVersion !== analysisVersion) throw shortformAbortError();
      const sceneCuts = mapSourcePointsToTimeline(asset.id, sceneSourceCuts);
      const silences = shortformSilenceRanges(asset.id);
      const deterministicCandidates = generateShortformCandidates(asset.id, transcript, sceneCuts, silences, state.shortform.targetDuration);
      if (!deterministicCandidates.length) throw new Error('현재 타임라인에서 목표 길이에 맞는 후보를 만들 수 없습니다. 목표 길이를 줄여보세요.');
      renderShortformState({
        analyzing: true, status: 'analyzing', progress: 0.9, candidates: deterministicCandidates,
        selectedId: deterministicCandidates[0].id, sceneCuts, message: '기본 후보를 만들었습니다. AI 보강 사용 여부를 확인하고 있습니다.',
      });
      const enrichment = await enrichShortformCandidates(deterministicCandidates, analysisVersion);
      if (state.shortform.analysisVersion !== analysisVersion) throw shortformAbortError();
      const candidates = enrichment.candidates;
      renderShortformState({
        analyzing: false, status: 'completed', progress: 1, candidates, selectedId: candidates[0].id, sceneCuts,
        message: `${candidates.length}개 후보를 만들었습니다. ${transcript.label}${sceneWarning ? ' 기반으로 생성했으며 장면 분석은 생략했습니다.' : '와 장면 변화를 함께 반영했습니다.'}${enrichment.enhanced ? ' LLM 의미 재평가와 제목 보강을 적용했습니다.' : enrichment.warning}`,
      });
      previewShortformCandidate(candidates[0].id, false);
    } catch (reason) {
      if (state.shortform.analysisVersion !== analysisVersion || reason?.name === 'AbortError') return;
      renderShortformState({
        analyzing: false, status: 'failed', progress: 1, candidates: [], selectedId: '', sceneCuts: [],
        message: reason instanceof Error ? reason.message : '숏폼 후보를 생성하지 못했습니다.',
      });
    }
  }

  function previewShortformCandidate(candidateId, autoplay = true) {
    const candidate = state.shortform.candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    stopPlayback();
    state.shortform.selectedId = candidate.id;
    state.shortform.previewEnd = candidate.end;
    seek(candidate.start, true);
    renderInspector();
    if (autoplay) document.querySelector(`[data-preview-shortform="${candidate.id}"]`)?.focus({ preventScroll: true });
    if (!autoplay) return;
    state.playing = true;
    state.lastFrameAt = performance.now();
    syncPreview(true);
    state.animation = requestAnimationFrame(animate);
    renderPlayback();
  }

  function clearShortformCandidates(message = '') {
    cancelLlmRequest();
    stopPlayback();
    renderShortformState({
      analyzing: false, status: 'idle', progress: 0, message, assetId: '', candidates: [], selectedId: '', sceneCuts: [], previewEnd: 0,
      analysisVersion: state.shortform.analysisVersion + 1,
    });
  }

  function cancelShortformAnalysis() {
    if (!state.shortform.analyzing) return;
    clearShortformCandidates('숏폼 후보 분석을 취소했습니다.');
  }

  function updateShortformTarget(value) {
    cancelLlmRequest();
    const targetDuration = [15, 30, 45, 60].includes(Number(value)) ? Number(value) : 30;
    const hadReview = state.shortform.analyzing || state.shortform.candidates.length > 0;
    stopPlayback();
    state.shortform = {
      ...state.shortform, targetDuration, analyzing: false, status: 'idle', progress: 0,
      message: hadReview ? '목표 길이가 변경되었습니다. 후보를 다시 생성하세요.' : '',
      assetId: '', candidates: [], selectedId: '', sceneCuts: [], previewEnd: 0,
      analysisVersion: state.shortform.analysisVersion + 1,
    };
    renderInspector();
  }

  function applyShortformCandidate() {
    if (state.shortform.analyzing) {
      renderShortformState({ message: '후보 분석이 끝난 뒤 적용하세요.' });
      return;
    }
    if (state.sttJob.active) {
      renderShortformState({ message: '진행 중인 자동 자막 작업을 먼저 완료하거나 취소하세요.' });
      return;
    }
    const candidate = state.shortform.candidates.find((item) => item.id === state.shortform.selectedId);
    if (!candidate) {
      renderShortformState({ message: '적용할 숏폼 후보를 선택하세요.' });
      return;
    }
    const { start, end } = candidate;
    stopPlayback();
    state.shortform.applying = true;
    try {
      commit((project) => {
        project.canvas = { ...project.canvas, ratio: '9:16', ...ratios['9:16'] };
        project.clips = project.clips.flatMap((clip) => {
          const clipStart = clip.timelineStart;
          const clipEnd = clip.timelineStart + clip.sourceEnd - clip.sourceStart;
          const keptStart = Math.max(start, clipStart);
          const keptEnd = Math.min(end, clipEnd);
          if (keptEnd - keptStart <= 0.03) return [];
          return [{
            ...clip,
            timelineStart: keptStart - start,
            sourceStart: clip.sourceStart + keptStart - clipStart,
            sourceEnd: clip.sourceStart + keptEnd - clipStart,
          }];
        });
        project.texts = project.texts.flatMap((text) => {
          if (candidate.signalSource === 'stt' && text.role === 'caption') return [];
          const keptStart = Math.max(start, text.start);
          const keptEnd = Math.min(end, text.end);
          if (keptEnd - keptStart <= 0.03) return [];
          return [{ ...text, start: keptStart - start, end: keptEnd - start }];
        });
        if (candidate.signalSource === 'stt') {
          const generatedCaptions = candidate.cues.flatMap((cue) => {
            const keptStart = Math.max(start, cue.start);
            const keptEnd = Math.min(end, cue.end);
            if (keptEnd - keptStart <= 0.03) return [];
            return [captionFromCue({
              ...cue, source: 'shortform-stt', start: keptStart - start, end: keptEnd - start,
            })];
          });
          project.texts.push(...generatedCaptions);
        }
        return project;
      });
    } finally {
      state.shortform.applying = false;
    }
    if (candidate.signalSource === 'stt') {
      clearTimeout(state.sttPollTimer);
      state.sttPollTimer = 0;
      state.sttProposal = null;
      state.sttJob = { active: false, status: 'idle', progress: 0, message: '', id: '', assetId: '', provider: '', demo: false };
    }
    state.playhead = 0;
    state.selection = null;
    state.shortform = {
      ...state.shortform, applying: false, analyzing: false, status: 'applied', progress: 1,
      message: `후보 #${candidate.rank}을 ${candidate.duration.toFixed(1)}초 숏폼 타임라인으로 적용했습니다. Undo로 복원할 수 있습니다.`,
      candidates: [], selectedId: '', sceneCuts: [], previewEnd: 0,
    };
    renderAll();
  }

  function renderShortformSection(asset) {
    const review = state.shortform;
    const selected = review.candidates.find((candidate) => candidate.id === review.selectedId);
    const targetOptions = [15, 30, 45, 60].map((duration) => `<option value="${duration}" ${review.targetDuration === duration ? 'selected' : ''}>${duration}초${duration === 30 ? ' · 추천' : ''}</option>`).join('');
    const cards = review.candidates.map((candidate) => `<article class="shortform-candidate ${candidate.id === review.selectedId ? 'selected' : ''}"><button type="button" data-preview-shortform="${candidate.id}" aria-pressed="${candidate.id === review.selectedId}" ${review.analyzing ? 'disabled' : ''}><span class="shortform-rank">#${candidate.rank}</span>${candidate.aiEnhanced ? '<span class="shortform-ai-badge">AI 보강</span>' : ''}<span class="shortform-score">${candidate.score}점</span><strong>${escapeHtml(candidate.title)}</strong>${candidate.summary ? `<p>${escapeHtml(candidate.summary)}</p>` : ''}<time>${formatTime(candidate.start, true)}–${formatTime(candidate.end, true)} · ${candidate.duration.toFixed(1)}초</time><small>${candidate.reasons.map((reason) => `<em>${escapeHtml(reason)}</em>`).join('')}</small></button></article>`).join('');
    return `<section class="property-section shortform-section">${state.inspectorAccordion.shortform ? `<div class="accordion-head open" data-accordion="shortform">` : `<div class="accordion-head" data-accordion="shortform">`}<div class="ai-title"><span>◆</span><div><h3>숏폼 후보 생성</h3><small>${asset ? escapeHtml(asset.name) : '타임라인 영상 필요'}</small></div></div><span class="accordion-chevron"></span></div><div class="accordion-body"${state.inspectorAccordion.shortform ? '' : ' hidden'}><label class="field"><span>목표 길이 <b>${review.targetDuration}초</b></span><select data-shortform-target ${review.analyzing ? 'disabled' : ''}>${targetOptions}</select></label><button id="analyzeShortformButton" class="shortform-analyze" ${!asset || review.analyzing || review.candidates.length || state.sttJob.active || state.silence.analyzing || hasPendingReframe() ? 'disabled' : ''}>${review.analyzing ? '하이라이트 분석 중…' : review.candidates.length ? '후보 검토 중' : '자동 후보 생성'} <span>${review.targetDuration}s</span></button>${review.analyzing ? `<div class="shortform-status"><div role="status" aria-live="polite"><span>${escapeHtml(review.message)}</span><b>${Math.round(review.progress * 100)}%</b></div><progress value="${review.progress}" max="1" aria-label="숏폼 후보 분석 진행률"></progress><button id="cancelShortformButton" class="danger-action">분석 취소</button></div>` : review.message ? `<p class="shortform-message ${review.status === 'failed' ? 'error' : ''}" role="status" aria-live="polite">${escapeHtml(review.message)}</p>` : ''}${review.candidates.length ? `<div class="shortform-review"><div class="shortform-review-head"><strong>추천 후보 ${review.candidates.length}개</strong><span>${review.candidates.some((candidate) => candidate.aiEnhanced) ? 'LLM 의미 보강' : escapeHtml(review.candidates[0].signalLabel)}</span></div><p class="shortform-help">점수와 근거를 확인하고 후보를 눌러 해당 구간을 미리보세요.</p><div class="shortform-list">${cards}</div><div class="proposal-actions"><button id="clearShortformButton">다시 생성</button><button id="applyShortformButton" class="apply" ${selected && !review.analyzing ? '' : 'disabled'}>선택 후보 적용</button></div></div>` : ''}</div></section>`;
  }

  function renderInspector() {
    const root = document.getElementById('inspectorContent');
    const clip = state.selection?.kind === 'clip' ? state.project.clips.find((item) => item.id === state.selection.id) : null;
    const asset = clip && state.project.assets.find((item) => item.id === clip.assetId);
    const text = state.selection?.kind === 'text' ? state.project.texts.find((item) => item.id === state.selection.id) : null;
    const sttAsset = getTranscribableAsset();
    const sttProposal = state.sttProposal;
    const shortformAsset = state.shortform.analyzing || state.shortform.candidates.length
      ? state.project.assets.find((item) => item.id === state.shortform.assetId)
      : getShortformAsset();
    const reframe = state.reframe;
    const reframeHasBoundAsset = reframe.analyzing || reframe.keyframes.length > 0;
    const reframeAsset = reframeHasBoundAsset
      ? state.project.assets.find((item) => item.id === reframe.assetId)
      : getReframeAsset();
    const appliedReframeCount = reframeAsset
      ? state.project.clips.filter((item) => item.assetId === reframeAsset.id && item.reframe?.enabled).length
      : 0;
    const reframeMethodLabel = { face: '얼굴 추적', hybrid: '얼굴+시각', visual: '시각 중심' }[reframe.method] || '분석';
    const silence = state.silence;
    const silenceHasBoundAsset = silence.analyzing || silence.candidates.length > 0;
    const silenceAsset = silenceHasBoundAsset
      ? state.project.assets.find((item) => item.id === silence.assetId)
      : sttAsset;
    const selectedSilences = silence.candidates.filter((candidate) => candidate.selected);
    const candidateTimelineRemovals = silence.candidates.map((candidate) => timelineRemovalsForSilences(silence.assetId, [candidate]));
    const selectedTimelineRemovals = timelineRemovalsForSilences(silence.assetId, selectedSilences);
    const selectedSilenceDuration = selectedTimelineRemovals.reduce((total, range) => total + range.end - range.start, 0);
    const sttRequiresServer = location.protocol === 'file:';
    const sttStatusLabel = {
      idle: 'STT', uploading: '업로드', queued: '대기', processing: '분석 중',
      completed: '검토 필요', failed: '실패', cancelled: '취소됨',
    }[state.sttJob.status] || 'STT';
    const numberField = (label, field, value, min = 0, max = '') => `<label class="field"><span>${label}</span><input data-field="${field}" type="number" min="${min}" ${max !== '' ? `max="${max}"` : ''} step="0.1" value="${Number(value).toFixed(2)}"></label>`;
    const acc = state.inspectorAccordion;
    const accHead = (key, html) => `<div class="accordion-head${acc[key] ? ' open' : ''}" data-accordion="${key}">${html}<span class="accordion-chevron"></span></div>`;
    const accBody = (key) => acc[key] ? '' : ' hidden';
    root.innerHTML = `
      <section class="property-section">${accHead('canvas', '<h3>캔버스</h3>')}<div class="accordion-body"${accBody('canvas')}><label class="field"><span>화면 비율</span><select data-field="canvas-ratio"><option value="9:16" ${state.project.canvas.ratio === '9:16' ? 'selected' : ''}>9:16 · Shorts</option><option value="1:1" ${state.project.canvas.ratio === '1:1' ? 'selected' : ''}>1:1 · Square</option><option value="16:9" ${state.project.canvas.ratio === '16:9' ? 'selected' : ''}>16:9 · Landscape</option></select></label><div class="ratio-meta"><span>${state.project.canvas.width} × ${state.project.canvas.height}</span><em>30 FPS</em></div></div></section>
      ${clip ? `<section class="property-section">${accHead('selection', `<div class="section-title"><h3>선택한 클립</h3><span class="type-pill">${clip.trackId}</span></div>`)}<div class="accordion-body"${accBody('selection')}><p class="selected-name">${escapeHtml(asset?.name || '미디어 없음')}</p><div class="field-grid">${numberField('타임라인 시작', 'clip-timelineStart', clip.timelineStart)}${numberField('소스 시작', 'clip-sourceStart', clip.sourceStart, 0, clip.sourceEnd - .1)}${numberField('소스 종료', 'clip-sourceEnd', clip.sourceEnd, clip.sourceStart + .1, asset?.duration || '')}</div><label class="field"><span>볼륨 <b>${Math.round(clip.volume * 100)}%</b></span><input data-field="clip-volume" type="range" min="0" max="1" step="0.01" value="${clip.volume}"></label><label class="field"><span>속도 <b>${(clip.speed || 1).toFixed(2)}x</b></span><input data-field="clip-speed" type="range" min="0.25" max="4" step="0.05" value="${clip.speed || 1}"></label><div class="field-grid"><label class="field"><span>페이드 인</span><input data-field="clip-fadeIn" type="number" min="0" max="5" step="0.1" value="${(clip.fadeIn || 0).toFixed(1)}"></label><label class="field"><span>페이드 아웃</span><input data-field="clip-fadeOut" type="number" min="0" max="5" step="0.1" value="${(clip.fadeOut || 0).toFixed(1)}"></label></div><div class="field-grid"><label class="field"><span>전환 효과</span><select data-field="clip-transition-type">${TRANSITION_TYPES.map((t) => `<option value="${t}" ${(clip.transition?.type || 'none') === t ? 'selected' : ''}>${TRANSITION_LABELS[t]}</option>`).join('')}</select></label><label class="field"><span>전환 길이</span><input data-field="clip-transition-duration" type="number" min="0" max="3" step="0.1" value="${(clip.transition?.duration || 0.5).toFixed(1)}"></label></div></div></section>` : ''}
      ${text ? `<section class="property-section">${accHead('selection', `<div class="section-title"><h3>${text.role === 'caption' ? '자막' : '텍스트'}</h3><span class="type-pill text">${text.role === 'caption' ? 'CC' : 'T'}</span></div>`)}<div class="accordion-body"${accBody('selection')}><label class="field"><span>내용</span><textarea data-field="text-text" rows="4">${escapeHtml(text.text)}</textarea></label><div class="field-grid">${numberField('시작', 'text-start', text.start)}${numberField('종료', 'text-end', text.end, text.start + .1)}</div><label class="field"><span>글자 크기 <b>${text.fontSize}px</b></span><div class="range-with-input"><input data-field="text-fontSize" type="range" min="12" max="120" value="${text.fontSize}"><input data-field="text-fontSize" type="number" min="12" max="120" step="1" value="${text.fontSize}"></div></label><label class="field"><span>굵기</span><select data-field="text-fontWeight">${[400,600,700,800,900].map((weight) => `<option value="${weight}" ${text.fontWeight === weight ? 'selected' : ''}>${weight}</option>`).join('')}</select></label><label class="field"><span>글꼴</span><select data-field="text-fontFamily">${['sans-serif','serif','monospace','Noto Sans KR','Pretendard','Inter'].map((f) => `<option value="${f}" ${(text.fontFamily || 'sans-serif') === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label><div class="color-fields"><label><span>글자</span><input data-field="text-color" type="color" value="${text.color}"></label><label><span>배경</span><input data-field="text-background" type="color" value="${text.background.slice(0,7)}"></label></div><div class="field-grid">${numberField('가로 위치 %', 'text-x', text.x, 0, 100)}${numberField('세로 위치 %', 'text-y', text.y, 0, 100)}</div><label class="field"><span>투명도 <b>${Math.round((text.opacity ?? 1) * 100)}%</b></span><div class="range-with-input"><input data-field="text-opacity" type="range" min="0" max="1" step="0.05" value="${text.opacity ?? 1}"><input data-field="text-opacity" type="number" min="0" max="1" step="0.05" value="${text.opacity ?? 1}"></div></label><label class="field"><span>박스 폭 <b>${text.boxWidth || 88}%</b></span><div class="range-with-input"><input data-field="text-boxWidth" type="range" min="30" max="100" step="1" value="${text.boxWidth || 88}"><input data-field="text-boxWidth" type="number" min="30" max="100" step="1" value="${text.boxWidth || 88}"></div></label><button type="button" id="applyBoxWidthAll" class="small-action">박스 폭 전체 자막 적용</button><div class="field keyframe-info"><span>키프레임 ${(text.keyframes || []).length}개</span><button type="button" id="addTextKeyframe" class="small-action">현재 위치 추가</button></div></div></section>` : ''}
      ${!clip && !text ? '<div class="selection-empty"><div>◇</div><strong>요소를 선택하세요</strong><span>타임라인의 클립이나 텍스트를 선택하면 세부 속성을 편집할 수 있습니다.</span></div>' : ''}
      <section class="property-section caption-section">${accHead('captions', '<div class="ai-title"><span>CC</span><div><h3>자막 도구</h3><small>SRT · WebVTT</small></div></div>')}<div class="accordion-body"${accBody('captions')}><button id="importCaptionsButton">자막 파일 가져오기 <span>SRT/VTT</span></button><button id="exportCaptionsButton" ${state.project.texts.some((item) => item.role === 'caption') ? '' : 'disabled'}>자막 SRT 저장 <span>${state.project.texts.filter((item) => item.role === 'caption').length}개</span></button>${state.captionMessage ? `<p class="caption-message">${escapeHtml(state.captionMessage)}</p>` : ''}</div></section>
      <section class="property-section ai-section">${accHead('stt', `<div class="ai-title"><span>✦</span><div><h3>AI 자동 자막</h3><small>${sttAsset ? escapeHtml(sttAsset.name) : '영상 또는 오디오 필요'}</small></div></div>`)}<div class="accordion-body"${accBody('stt')}><button id="autoCaptionButton" ${!sttAsset || state.sttJob.active || sttProposal || sttRequiresServer || state.shortform.analyzing || state.shortform.candidates.length ? 'disabled' : ''}>자동 자막 생성 <span>${sttStatusLabel}</span></button>${sttRequiresServer ? '<p class="ai-notice">자동 자막 API는 <code>npm run dev</code> 실행 시 사용할 수 있습니다. 단일 HTML에서는 SRT/VTT 가져오기를 이용하세요.</p>' : ''}${state.sttJob.active ? `<div class="stt-status"><div><span>${escapeHtml(state.sttJob.message)}</span><b>${Math.round(state.sttJob.progress * 100)}%</b></div><progress value="${state.sttJob.progress}" max="1"></progress><button id="cancelSttButton" class="danger-action">작업 취소</button></div>` : state.sttJob.message ? `<p class="stt-message ${state.sttJob.status === 'failed' ? 'error' : ''}">${escapeHtml(state.sttJob.message)}</p>` : ''}${sttProposal ? `<div class="stt-proposal"><div class="proposal-head"><strong>자막 제안 ${sttProposal.segments.length}개</strong><span>${escapeHtml(sttProposal.provider)}${sttProposal.demo ? ' · DEMO' : ''}</span></div><div class="proposal-list">${sttProposal.segments.slice(0, 4).map((segment) => `<div><time>${formatTime(segment.start)}–${formatTime(segment.end)}</time><p>${escapeHtml(segment.text)}</p>${Number.isFinite(segment.confidence) ? `<em>${Math.round(segment.confidence * 100)}%</em>` : ''}</div>`).join('')}</div><div class="proposal-actions"><button id="dismissSttButton">취소</button><button id="applySttButton" class="apply">타임라인에 적용</button></div></div>` : ''}</div></section>
      ${renderShortformSection(shortformAsset)}
      <section class="property-section reframe-section">${accHead('reframe', `<div class="ai-title"><span>▣</span><div><h3>세로 자동 리프레임</h3><small>${reframeAsset ? `${reframeHasBoundAsset ? '분석 대상 · ' : ''}${escapeHtml(reframeAsset.name)}` : reframeHasBoundAsset ? '분석 대상이 삭제됨' : '가로 영상 필요'}</small></div></div>`)}<div class="accordion-body"${accBody('reframe')}><label class="field"><span>프레임 샘플 간격</span><select data-reframe-setting="sampleInterval" ${reframe.analyzing ? 'disabled' : ''}><option value="0.5" ${reframe.sampleInterval === 0.5 ? 'selected' : ''}>0.5초 · 정밀</option><option value="1" ${reframe.sampleInterval === 1 ? 'selected' : ''}>1초 · 균형</option><option value="2" ${reframe.sampleInterval === 2 ? 'selected' : ''}>2초 · 빠름</option></select></label><button id="analyzeReframeButton" ${!reframeAsset || reframe.analyzing || reframe.keyframes.length || state.shortform.analyzing || state.shortform.candidates.length ? 'disabled' : ''}>${reframe.analyzing ? '피사체 추적 중…' : reframe.keyframes.length ? '키프레임 검토 중' : '세로 구도 분석'} <span>9:16</span></button>${appliedReframeCount && !reframe.keyframes.length ? `<button id="removeReframeButton" class="reframe-remove" data-reframe-asset="${reframeAsset.id}">적용된 리프레임 해제 <span>${appliedReframeCount}개</span></button>` : ''}${reframe.analyzing ? `<div class="reframe-status"><div><span>${escapeHtml(reframe.message)}</span><b>${Math.round(reframe.progress * 100)}%</b></div><progress value="${reframe.progress}" max="1"></progress><button id="cancelReframeButton" class="danger-action">분석 취소</button></div>` : reframe.message ? `<p class="reframe-message ${reframe.status === 'failed' ? 'error' : ''}">${escapeHtml(reframe.message)}</p>` : ''}${reframe.keyframes.length ? `<div class="reframe-review"><div class="reframe-review-head"><strong>포커스 키프레임 ${reframe.keyframes.length}개</strong><span>${reframeMethodLabel}</span></div><p class="reframe-help">시간을 눌러 구도를 확인하고 가로 위치를 직접 보정할 수 있습니다.</p><div class="reframe-keyframes">${reframe.keyframes.map((keyframe, index) => `<div class="reframe-keyframe"><button type="button" data-preview-reframe="${index}">${formatTime(keyframe.time, true)}</button><label><span>가로 ${Math.round(keyframe.x * 100)}%</span><input type="range" min="0" max="100" step="1" value="${Math.round(keyframe.x * 100)}" data-reframe-keyframe="${index}" data-reframe-axis="x"></label><em>${Math.round(keyframe.confidence * 100)}%</em></div>`).join('')}</div><div class="proposal-actions"><button id="clearReframeButton">취소</button><button id="applyReframeButton" class="apply">9:16에 적용</button></div></div>` : ''}</div></section>
      <section class="property-section silence-section">${accHead('silence', `<div class="ai-title"><span>∿</span><div><h3>침묵 구간 감지</h3><small>${silenceAsset ? `${silenceHasBoundAsset ? '분석 대상 · ' : ''}${escapeHtml(silenceAsset.name)}` : silenceHasBoundAsset ? '분석 대상이 삭제됨' : '영상 또는 오디오 필요'}</small></div></div>`)}<div class="accordion-body"${accBody('silence')}><div class="field-grid silence-settings"><label class="field"><span>임계값 dB</span><input data-silence-field="thresholdDb" type="number" min="-80" max="-5" step="1" value="${silence.thresholdDb}" ${silence.analyzing ? 'disabled' : ''}></label><label class="field"><span>최소 길이 초</span><input data-silence-field="minimumDuration" type="number" min="0.1" max="10" step="0.1" value="${silence.minimumDuration}" ${silence.analyzing ? 'disabled' : ''}></label></div><label class="field"><span>음성 여백 초 <b>${silence.padding.toFixed(2)}</b></span><input data-silence-field="padding" type="range" min="0" max="1" step="0.01" value="${silence.padding}" ${silence.analyzing ? 'disabled' : ''}></label><button id="analyzeSilenceButton" class="silence-analyze" ${!sttAsset || silence.analyzing || silence.candidates.length || state.shortform.analyzing || state.shortform.candidates.length ? 'disabled' : ''}>${silence.analyzing ? '오디오 분석 중…' : silence.candidates.length ? '후보 검토 중' : '침묵 구간 분석'} <span>${silence.thresholdDb} dB</span></button>${silence.analyzing ? `<div class="silence-status"><div><span>${escapeHtml(silence.message)}</span><b>${Math.round(silence.progress * 100)}%</b></div><progress value="${silence.progress}" max="1"></progress></div>` : silence.message ? `<p class="silence-message ${silence.status === 'failed' ? 'error' : ''}">${escapeHtml(silence.message)}</p>` : ''}${silence.candidates.length ? `<div class="silence-review"><div class="silence-review-head"><strong>삭제 후보 ${silence.candidates.length}개</strong><span>${selectedSilences.length}개 선택</span></div><div class="silence-list">${silence.candidates.map((candidate, index) => { const occurrences = candidateTimelineRemovals[index]; const occurrenceDuration = occurrences.reduce((total, range) => total + range.end - range.start, 0); return `<div class="silence-candidate"><label><input type="checkbox" data-silence-candidate="${index}" ${candidate.selected ? 'checked' : ''} ${occurrences.length ? '' : 'disabled'}><span><strong>${formatTime(candidate.start, true)}–${formatTime(candidate.end, true)}</strong><small>${occurrences.length ? `타임라인 ${occurrences.length}곳 · 실제 ${occurrenceDuration.toFixed(2)}초` : '현재 타임라인에 적용 구간 없음'}</small></span></label><div class="silence-occurrences">${occurrences.map((range, occurrenceIndex) => `<button type="button" data-preview-silence="${index}" data-preview-occurrence="${occurrenceIndex}" title="${formatTime(range.start, true)}–${formatTime(range.end, true)}로 이동">${occurrenceIndex + 1}</button>`).join('')}</div></div>`; }).join('')}</div><div class="silence-total"><span>타임라인 ${selectedTimelineRemovals.length}개 구간</span><strong>${selectedSilenceDuration.toFixed(2)}초</strong></div><div class="proposal-actions"><button id="clearSilenceButton">취소</button><button id="applySilenceButton" class="apply" ${selectedTimelineRemovals.length && silenceAsset ? '' : 'disabled'}>리플 삭제 적용</button></div></div>` : ''}</div></section><button id="jsonExport" class="button json-button">프로젝트 JSON 다운로드</button>`;
  }

  function renderTimeline() {
    const width = Math.max(900, state.project.duration * state.zoom + 80);
    const interval = state.zoom < 12 ? 5 : state.zoom < 24 ? 2 : 1;
    const ruler = Array.from({ length: Math.ceil(state.project.duration) + 1 }, (_, i) => i)
      .filter((i) => i % interval === 0).map((i) => `<span style="left:${i * state.zoom}px">${formatTime(i)}</span>`).join('');
    const clips = (track) => state.project.clips.filter((clip) => clip.trackId === track).map((clip) => {
      const asset = state.project.assets.find((item) => item.id === clip.assetId);
      const duration = clipDuration(clip);
      const waveformSvg = asset?.waveform && track === 'audio' ? `<svg class="clip-waveform" viewBox="0 0 128 32" preserveAspectRatio="none">${asset.waveform.map((v, i) => `<rect x="${i}" y="${16 - v * 15}" width="1" height="${v * 30 || 0.5}"/>`).join('')}</svg>` : '';
      return `<div class="timeline-clip ${track} ${isSelected('clip', clip.id) ? 'is-selected' : ''}" data-select-clip="${clip.id}" draggable="true" style="left:${clip.timelineStart * state.zoom}px;width:${Math.max(18, duration * state.zoom)}px"><button class="trim-handle left" data-trim="start" data-clip="${clip.id}"></button>${asset?.thumbnail && track === 'video' ? `<span class="clip-thumb" style="background-image:url('${asset.thumbnail}')"></span>` : ''}${waveformSvg}<span class="clip-label"><b>${track === 'audio' ? '♪' : '▶'}</b>${escapeHtml(asset?.name || '미디어 없음')}</span><span class="clip-duration">${duration.toFixed(1)}s</span><button class="trim-handle right" data-trim="end" data-clip="${clip.id}"></button></div>`;
    }).join('');
    const texts = state.project.texts.map((text) => `<div class="timeline-clip text ${text.role === 'caption' ? 'caption' : ''} ${isSelected('text', text.id) ? 'is-selected' : ''}" data-select-text="${text.id}" style="left:${text.start * state.zoom}px;width:${Math.max(24, (text.end-text.start)*state.zoom)}px"><span class="clip-label"><b>${text.role === 'caption' ? 'CC' : 'T'}</b>${escapeHtml(text.text)}</span></div>`).join('');
    document.getElementById('timelineContent').style.width = `${width + LABEL_WIDTH}px`;
    document.getElementById('timelineContent').innerHTML = `<div class="timeline-label-spacer">TIME</div><div class="timeline-ruler" style="margin-left:${LABEL_WIDTH}px;width:${width}px">${ruler}</div><div class="playhead" style="left:${LABEL_WIDTH + state.playhead * state.zoom}px"><i></i><span></span></div><div class="track-row"><div class="track-label"><b>V1</b><span>영상</span></div><div class="track-lane" style="width:${width}px">${clips('video')}</div></div><div class="track-row text-track"><div class="track-label"><b>T1</b><span>텍스트·자막</span></div><div class="track-lane" style="width:${width}px">${texts}</div></div><div class="track-row"><div class="track-label"><b>A1</b><span>오디오</span></div><div class="track-lane" style="width:${width}px">${clips('audio')}</div></div>`;
    document.getElementById('elementCount').textContent = `${state.project.clips.length + state.project.texts.length}개 요소`;
    document.getElementById('zoomInput').value = state.zoom;
  }

  function renderSettingsModal() {
    const ui = state.ui;
    const statusBadge = (available, label) => `<span class="settings-status ${available ? 'available' : 'unavailable'}">${available ? '연결됨' : label}</span>`;
    const stt = state.serverStatus.stt;
    const render = state.serverStatus.render;
    const llmAvailable = state.llm.available;
    const llmReasonLabels = {
      'provider-disabled': 'LLM_PROVIDER가 disabled입니다.',
      'unsupported-provider': '지원하지 않는 LLM Provider입니다.',
      'missing-credentials': 'LLM_MODEL 또는 LLM_API_KEY가 비어 있습니다.',
      'runtime-unsupported': '서버 런타임에서 외부 LLM 요청을 지원하지 않습니다.',
      'invalid-configuration': 'LLM_BASE_URL 등 서버 설정이 올바르지 않습니다.',
      'server-unavailable': 'LLM 서버 상태를 확인할 수 없습니다.',
    };
    const llmSetupReason = llmAvailable
      ? `${state.llm.provider}${state.llm.model ? ` · ${state.llm.model}` : ''} 사용 가능`
      : llmReasonLabels[state.llm.reasonCode] || state.llm.message;
    const connection = state.llm.connection;
    const connectionStatusClass = ['success', 'error', 'testing'].includes(connection.status) ? connection.status : 'idle';
    const configurationLabel = state.llm.configurationSource === 'browser-runtime'
      ? '웹 설정 · 서버 재시작 전까지 유지'
      : 'Docker/서버 환경변수';
    return `<div class="modal-backdrop"><section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><div class="modal-heading"><div><span class="eyebrow">PREFERENCES</span><h2 id="settingsTitle">편집기 설정</h2><p>레이아웃과 AI 작업 방식을 내 환경에 맞게 조정합니다.</p></div><button id="closeSettingsButton" aria-label="설정 닫기">×</button></div><div class="settings-scroll"><section class="settings-group"><div class="settings-group-title"><div><strong>작업 공간</strong><small>패널 경계를 직접 드래그하거나 정확한 크기를 지정하세요.</small></div><button id="resetLayoutButton" class="text-action">기본값 복원</button></div><div class="layout-presets"><button data-layout-preset="balanced"><span>▥</span><strong>균형</strong></button><button data-layout-preset="focus"><span>▣</span><strong>프리뷰 집중</strong></button><button data-layout-preset="timeline"><span>▤</span><strong>타임라인 집중</strong></button></div><div class="settings-grid"><label class="settings-range"><span>미디어 패널 <b>${Math.round(ui.libraryWidth)}px</b></span><input type="range" min="180" max="420" step="2" value="${ui.libraryWidth}" data-ui-setting="libraryWidth"></label><label class="settings-range"><span>속성 패널 <b>${Math.round(ui.inspectorWidth)}px</b></span><input type="range" min="220" max="460" step="2" value="${ui.inspectorWidth}" data-ui-setting="inspectorWidth"></label><label class="settings-range wide"><span>타임라인 높이 <b>${Math.round(ui.timelineHeight)}px</b></span><input type="range" min="150" max="520" step="2" value="${ui.timelineHeight}" data-ui-setting="timelineHeight"></label></div><div class="settings-toggles"><label><span><strong>미디어 패널</strong><small>왼쪽 라이브러리 표시</small></span><input type="checkbox" data-ui-toggle="libraryVisible" ${ui.libraryVisible ? 'checked' : ''}></label><label><span><strong>속성 패널</strong><small>오른쪽 Inspector 표시</small></span><input type="checkbox" data-ui-toggle="inspectorVisible" ${ui.inspectorVisible ? 'checked' : ''}></label><label><span><strong>타임라인</strong><small>하단 편집 영역 표시</small></span><input type="checkbox" data-ui-toggle="timelineVisible" ${ui.timelineVisible ? 'checked' : ''}></label></div></section><section class="settings-group"><div class="settings-group-title"><div><strong>편집 환경</strong><small>프리뷰와 인터페이스 표시 방식을 선택합니다.</small></div></div><div class="settings-toggles"><label><span><strong>Safe Zone 표시</strong><small>자막·UI 안전 영역 가이드</small></span><input type="checkbox" data-ui-toggle="showSafeZone" ${ui.showSafeZone ? 'checked' : ''}></label><label><span><strong>컴팩트 도구 모음</strong><small>아이콘 중심으로 상단 공간 절약</small></span><input type="checkbox" data-ui-toggle="compactToolbar" ${ui.compactToolbar ? 'checked' : ''}></label><label><span><strong>모션 줄이기</strong><small>전환과 강조 애니메이션 최소화</small></span><input type="checkbox" data-ui-toggle="reducedMotion" ${ui.reducedMotion ? 'checked' : ''}></label></div><label class="settings-select"><span>자동 자막 기본 언어</span><select data-ui-setting="transcriptionLanguage"><option value="ko" ${ui.transcriptionLanguage === 'ko' ? 'selected' : ''}>한국어</option><option value="en" ${ui.transcriptionLanguage === 'en' ? 'selected' : ''}>English</option><option value="ja" ${ui.transcriptionLanguage === 'ja' ? 'selected' : ''}>日本語</option></select></label></section><section class="settings-group"><div class="settings-group-title"><div><strong>AI 도움</strong><small>로컬 LLM 키는 세션 전용으로 입력할 수 있고, 영구 자격 증명은 Docker/서버 환경변수에서 관리합니다.</small></div></div><div class="settings-toggles single"><label><span><strong>숏폼 의미 기반 보강</strong><small>LLM으로 순위·제목·요약·근거를 보강</small></span><input type="checkbox" data-setting-semantic ${state.llm.semanticAssist ? 'checked' : ''}></label></div><div class="server-status-grid"><article><div><span>LLM</span>${statusBadge(llmAvailable, state.llm.healthStatus === 'checking' ? '확인 중' : '미설정')}</div><strong>${escapeHtml(state.llm.provider || 'disabled')}</strong><small>${escapeHtml(state.llm.model || state.llm.message)}</small></article><article><div><span>STT</span>${statusBadge(stt.available, stt.message === '확인 전' ? '확인 전' : '사용 불가')}</div><strong>${escapeHtml(stt.provider || '미설정')}</strong><small>${escapeHtml(stt.demo ? 'Demo Provider' : stt.message)}</small></article><article><div><span>MP4</span>${statusBadge(render.available, '사용 불가')}</div><strong>FFmpeg</strong><small>${escapeHtml(render.message)}</small></article></div><div class="server-config-note"><div class="server-config-heading"><div><strong>로컬 LLM 연결</strong><span>${escapeHtml(configurationLabel)}</span></div></div><p>Docker Desktop에서 실행 중인 앱이 Mac의 Ollama·LM Studio와 연결되도록 주소와 model ID를 설정합니다. API key는 연결 테스트·적용 요청에만 전송되며 브라우저 저장소·서버 응답·로그에 저장하지 않습니다.</p><div class="llm-connection-presets"><button type="button" data-llm-preset="ollama" ${connection.busy ? 'disabled' : ''}>Ollama · 11434</button><button type="button" data-llm-preset="lm-studio" ${connection.busy ? 'disabled' : ''}>LM Studio · 1234</button></div><div class="llm-connection-fields"><label><span>OpenAI-compatible Base URL</span><input type="url" inputmode="url" autocomplete="off" spellcheck="false" data-llm-config="baseUrl" value="${escapeHtml(connection.baseUrl)}" placeholder="http://host.docker.internal:11434/v1" ${connection.busy ? 'disabled' : ''}></label><label><span>Model ID</span><input type="text" autocomplete="off" spellcheck="false" maxlength="160" data-llm-config="model" value="${escapeHtml(connection.model)}" placeholder="예: qwen2.5:7b" ${connection.busy ? 'disabled' : ''}></label><label class="wide"><span>API Key <em>선택 · 저장 안 함</em></span><input type="password" autocomplete="new-password" spellcheck="false" maxlength="2048" data-llm-config="apiKey" value="${escapeHtml(connection.apiKey)}" placeholder="인증이 없으면 비워 두세요" ${connection.busy ? 'disabled' : ''}></label></div><p class="llm-connection-help">웹 설정은 HTTP/HTTPS OpenAI-compatible 서버 주소를 허용합니다. API key는 적용 성공 또는 설정창 닫기 시 브라우저 메모리에서도 지우며, 적용값은 서버 메모리에만 유지됩니다. 컨테이너를 재시작하면 <code>.env</code> 설정으로 돌아갑니다.</p><p class="llm-connection-result ${connectionStatusClass}" role="status" aria-live="polite">${escapeHtml(connection.message)}</p><p class="server-config-current"><b>현재 연결</b> ${escapeHtml(llmSetupReason)}</p><div class="server-config-actions"><button id="testLlmConnectionButton" type="button" aria-busy="${connection.busy}" aria-disabled="${connection.busy}">${connection.busy && connection.status === 'testing' ? '테스트 중…' : '연결 테스트'}</button><button id="applyLlmConnectionButton" type="button" class="primary-config-action" aria-busy="${connection.busy}" aria-disabled="${connection.busy}">${connection.busy && connection.status === 'testing' ? '처리 중…' : '테스트 후 적용'}</button><button id="copyLlmEnvButton" type="button">영구 설정 예시 복사</button><button id="refreshServerStatusButton" type="button" aria-busy="${state.serverStatus.refreshing}" class="${state.serverStatus.refreshing ? 'is-loading' : ''}">${state.serverStatus.refreshing ? '상태 확인 중…' : '상태 새로고침'}</button></div></div></section></div><div class="settings-actions"><button id="closeSettingsDoneButton" class="button primary">설정 완료</button></div></section></div>`;
  }

  function renderModal() {
    const root = document.getElementById('modalRoot');
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const focusSelector = active?.id
      ? `#${active.id}`
      : active?.dataset.layoutPreset
        ? `[data-layout-preset="${active.dataset.layoutPreset}"]`
        : active?.dataset.llmPreset
          ? `[data-llm-preset="${active.dataset.llmPreset}"]`
          : active?.dataset.llmConfig
            ? `[data-llm-config="${active.dataset.llmConfig}"]`
            : active?.dataset.uiSetting
          ? `[data-ui-setting="${active.dataset.uiSetting}"]`
          : active?.dataset.uiToggle
            ? `[data-ui-toggle="${active.dataset.uiToggle}"]`
            : active?.dataset.settingSemantic !== undefined
              ? '[data-setting-semantic]'
              : '';
    if (state.settingsOpen) {
      root.innerHTML = renderSettingsModal();
      if (focusSelector) queueMicrotask(() => root.querySelector(focusSelector)?.focus());
      return;
    }
    if (!state.exportOpen) { root.innerHTML = ''; return; }
    const progress = state.exportProgress;
    const capability = state.exportCapability;
    const mp4Reason = capability.loading
      ? 'FFmpeg 서버 상태 확인 중…'
      : capability.available
        ? 'FFmpeg 비동기 렌더 · 빠른 시작 지원'
        : capability.message;
    const format = state.exportFormat === 'mp4' && capability.available ? 'mp4' : 'webm';
    const isMp4 = format === 'mp4';
    root.innerHTML = `<div class="modal-backdrop"><section class="export-dialog" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow">EXPORT</span><h2>영상 내보내기</h2></div><button id="closeModal" ${progress.active ? 'disabled' : ''}>×</button></div><div class="export-preview"><div style="aspect-ratio:${state.project.canvas.width}/${state.project.canvas.height}">${state.project.canvas.ratio}</div><span>${escapeHtml(state.project.title)}</span></div><div class="export-format-grid"><label class="export-format ${isMp4 ? 'selected' : ''} ${capability.available ? '' : 'disabled'}"><input type="radio" name="exportFormat" value="mp4" ${isMp4 ? 'checked' : ''} ${progress.active || !capability.available ? 'disabled' : ''}><strong>MP4</strong><small>${escapeHtml(mp4Reason)}</small></label><label class="export-format ${!isMp4 ? 'selected' : ''}"><input type="radio" name="exportFormat" value="webm" ${!isMp4 ? 'checked' : ''} ${progress.active ? 'disabled' : ''}><strong>WebM</strong><small>브라우저 실시간 렌더 · 서버 불필요</small></label></div><label class="field"><span>화질</span><select id="exportQuality" ${progress.active ? 'disabled' : ''}><option value="draft">Draft · 540p · 빠른 확인</option><option value="hd">HD · 1080p · 고화질</option></select></label><div class="export-details"><span>${isMp4 ? 'H.264 MP4' : 'WebM'}</span><span>30 FPS</span><span>${state.project.duration.toFixed(1)}초</span></div><p class="export-note">${isMp4 ? '원본을 서버에 업로드한 뒤 비동기 FFmpeg Job으로 영상·오디오·자막·리프레임을 합성합니다.' : '브라우저에서 실시간 합성하므로 영상 길이만큼 시간이 걸립니다.'}</p>${progress.active ? `<div class="progress-wrap"><div><span>${escapeHtml(progress.status)}</span><b>${Math.round(progress.progress * 100)}%</b></div><progress value="${progress.progress}" max="1"></progress></div>` : ''}<p id="exportError" class="inline-error" ${state.exportError ? '' : 'hidden'}>${escapeHtml(state.exportError)}</p><div class="export-actions">${progress.active ? '<button id="cancelExport" class="button export-cancel">내보내기 취소</button>' : ''}<button id="startExport" class="button primary modal-export" ${progress.active || !state.project.assets.length ? 'disabled' : ''}>${progress.active ? (progress.format === 'mp4' ? 'MP4 렌더링 중…' : 'WebM 렌더링 중…') : `${isMp4 ? 'MP4' : 'WebM'} 다운로드`}</button></div></section></div>`;
  }

  function renderAll() {
    renderToolbar(); renderAssets(); renderInspector(); renderTimeline(); syncPreview(); renderModal();
  }

  async function addFiles(files) {
    const error = document.getElementById('mediaError'); error.hidden = true;
    document.querySelector('#dropZone strong').textContent = '미디어 분석 중…';
    for (const file of files) {
      if (!['video/', 'audio/', 'image/'].some((prefix) => file.type.startsWith(prefix))) continue;
      try {
        const id = uid(); const asset = await inspectFile(file, id); await saveBlob(id, file);
        if (asset.kind === 'audio' || asset.kind === 'video') {
          asset.waveform = await generateWaveform(file);
        }
        commit((project) => {
          const trackId = asset.kind === 'audio' ? 'audio' : 'video';
          const start = project.clips.filter((clip) => clip.trackId === trackId).reduce((end, clip) => Math.max(end, clip.timelineStart + clip.sourceEnd - clip.sourceStart), 0);
          project.assets.push(asset); project.clips.push({ id: uid(), assetId: id, trackId, timelineStart: start, sourceStart: 0, sourceEnd: Math.max(.1, asset.duration), volume: 1 });
          return project;
        });
      } catch (reason) { error.textContent = reason.message || '파일을 추가하지 못했습니다.'; error.hidden = false; }
    }
    document.querySelector('#dropZone strong').textContent = '미디어 추가';
  }

  function addAssetToTimeline(id) {
    commit((project) => {
      const asset = project.assets.find((item) => item.id === id); if (!asset) return project;
      const trackId = asset.kind === 'audio' ? 'audio' : 'video';
      const start = project.clips.filter((clip) => clip.trackId === trackId).reduce((end, clip) => Math.max(end, clip.timelineStart + clip.sourceEnd - clip.sourceStart), 0);
      const newClip = { id: uid(), assetId: id, trackId, timelineStart: start, sourceStart: 0, sourceEnd: Math.max(.1, asset.duration), volume: 1 };
      const inheritedReframe = asset.reframe || project.clips.find((clip) => clip.assetId === id && clip.reframe?.enabled)?.reframe;
      if (inheritedReframe) newClip.reframe = clone(inheritedReframe);
      project.clips.push(newClip); return project;
    });
  }

  async function removeAsset(id) {
    await removeBlob(id).catch(() => undefined);
    const invalidatesSilence = state.silence.assetId === id;
    const invalidatesReframe = state.reframe.assetId === id;
    commit((project) => ({ ...project, assets: project.assets.filter((asset) => asset.id !== id), clips: project.clips.filter((clip) => clip.assetId !== id) }));
    state.selection = null;
    if (invalidatesReframe) {
      state.reframe = {
        ...state.reframe, analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', method: '', keyframes: [],
        analysisVersion: state.reframe.analysisVersion + 1,
      };
      persistReframeDraft();
    }
    if (invalidatesSilence) {
      state.silence = {
        ...state.silence, analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', candidates: [],
        analysisVersion: state.silence.analysisVersion + 1,
      };
    }
    renderAll();
  }

  function splitSelected() {
    if (state.selection?.kind !== 'clip') return;
    const selectedId = state.selection.id;
    commit((project) => {
      const clip = project.clips.find((item) => item.id === selectedId); if (!clip) return project;
      const local = state.playhead - clip.timelineStart; const duration = clip.sourceEnd - clip.sourceStart;
      if (local <= .05 || local >= duration - .05) return project;
      const source = clip.sourceStart + local; clip.sourceEnd = source;
      project.clips.push({ ...clip, id: uid(), timelineStart: state.playhead, sourceStart: source, sourceEnd: source + duration - local }); return project;
    });
  }

  function deleteSelection() {
    if (!state.selection && !state.selections.length) return;
    if (state.selections.length <= 1 && state.selection?.kind === 'asset') { void removeAsset(state.selection.id); return; }
    const clipIds = new Set(state.selections.filter((s) => s.kind === 'clip').map((s) => s.id));
    const textIds = new Set(state.selections.filter((s) => s.kind === 'text').map((s) => s.id));
    if (!clipIds.size && !textIds.size) return;
    commit((project) => ({
      ...project,
      clips: project.clips.filter((clip) => !clipIds.has(clip.id)),
      texts: project.texts.filter((text) => !textIds.has(text.id)),
    }));
    clearSelection();
  }

  function duplicateSelection() {
    if (!state.selections.length) return;
    const newSelections = [];
    commit((project) => {
      for (const sel of state.selections) {
        if (sel.kind === 'clip') {
          const clip = project.clips.find((item) => item.id === sel.id);
          if (!clip) continue;
          const duration = clip.sourceEnd - clip.sourceStart;
          const newId = uid();
          project.clips.push({ ...clone(clip), id: newId, timelineStart: clip.timelineStart + duration });
          newSelections.push({ kind: 'clip', id: newId });
        } else if (sel.kind === 'text') {
          const text = project.texts.find((item) => item.id === sel.id);
          if (!text) continue;
          const duration = text.end - text.start;
          const newId = uid();
          project.texts.push({ ...clone(text), id: newId, start: text.end, end: text.end + duration });
          newSelections.push({ kind: 'text', id: newId });
        }
      }
      return project;
    });
    state.selections = newSelections;
    state.selection = newSelections.at(-1) || null;
  }

  function addTextKeyframe() {
    if (state.selection?.kind !== 'text') return;
    const textId = state.selection.id;
    const text = state.project.texts.find((item) => item.id === textId);
    if (!text || state.playhead < text.start || state.playhead > text.end) return;
    const progress = (state.playhead - text.start) / Math.max(0.01, text.end - text.start);
    commit((project) => {
      const t = project.texts.find((item) => item.id === textId);
      if (!t) return project;
      if (!t.keyframes) t.keyframes = [];
      // Remove existing keyframe at same time (±0.01)
      t.keyframes = t.keyframes.filter((kf) => Math.abs(kf.t - progress) > 0.01);
      t.keyframes.push({ t: Number(progress.toFixed(3)), x: t.x, y: t.y, fontSize: t.fontSize, opacity: t.opacity ?? 1 });
      t.keyframes.sort((a, b) => a.t - b.t);
      return project;
    });
  }

  function applyBoxWidthToAll() {
    if (state.selection?.kind !== 'text') return;
    const source = state.project.texts.find((item) => item.id === state.selection.id);
    if (!source) return;
    const boxWidth = source.boxWidth || 88;
    commit((project) => {
      for (const text of project.texts) {
        text.boxWidth = boxWidth;
      }
      return project;
    });
  }

  function parseSubtitleTime(value) {
    const parts = value.trim().replace(',', '.').split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part)) || (parts.length !== 2 && parts.length !== 3)) {
      throw new Error(`잘못된 자막 시간 형식입니다: ${value}`);
    }
    const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    return hours * 3600 + minutes * 60 + seconds;
  }

  function parseSubtitleFile(source) {
    const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];
    return normalized.split(/\n{2,}/).flatMap((block) => {
      const lines = block.split('\n').map((line) => line.trimEnd());
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) return [];
      const timing = lines[timingIndex].match(/^\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})/);
      if (!timing) return [];
      const text = lines.slice(timingIndex + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (!text) return [];
      const start = parseSubtitleTime(timing[1]);
      const end = parseSubtitleTime(timing[2]);
      return end > start ? [{ start, end, text }] : [];
    });
  }

  function captionFromCue(cue) {
    return {
      id: uid(), role: 'caption', source: cue.source || 'import',
      text: cue.text, start: cue.start, end: cue.end,
      confidence: Number.isFinite(cue.confidence) ? cue.confidence : undefined,
      speaker: cue.speaker,
      x: 50, y: 82, fontSize: 58, fontWeight: 800,
      color: '#ffffff', background: '#000000bb', align: 'center',
    };
  }

  async function importCaptions(file) {
    try {
      const cues = parseSubtitleFile(await file.text());
      if (!cues.length) throw new Error('유효한 자막 구간을 찾지 못했습니다. SRT 또는 VTT 형식을 확인하세요.');
      const captions = cues.map(captionFromCue);
      commit((project) => {
        project.texts.push(...captions);
        return project;
      });
      state.selection = { kind: 'text', id: captions[0].id };
      state.playhead = captions[0].start;
      state.captionMessage = `${file.name}에서 자막 ${captions.length}개를 가져왔습니다.`;
      renderAll();
    } catch (reason) {
      state.captionMessage = reason instanceof Error ? reason.message : '자막 파일을 가져오지 못했습니다.';
      renderInspector();
    }
  }

  function formatSrtTime(seconds) {
    const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(totalMilliseconds / 3600000);
    const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
    const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
  }

  function exportCaptions() {
    const captions = state.project.texts
      .filter((text) => text.role === 'caption')
      .sort((first, second) => first.start - second.start);
    if (!captions.length) {
      state.captionMessage = '내보낼 자막이 없습니다.';
      renderInspector();
      return;
    }
    const srt = captions.map((caption, index) => `${index + 1}\n${formatSrtTime(caption.start)} --> ${formatSrtTime(caption.end)}\n${caption.text}`).join('\n\n');
    downloadBlob(new Blob([`\uFEFF${srt}\n`], { type: 'application/x-subrip;charset=utf-8' }), `${safeName(state.project.title)}.srt`);
    state.captionMessage = `자막 ${captions.length}개를 SRT로 저장했습니다.`;
    renderInspector();
  }

  function getTranscribableAsset() {
    if (state.selection?.kind === 'asset') {
      const selected = state.project.assets.find((asset) => asset.id === state.selection.id);
      if (selected && (selected.kind === 'video' || selected.kind === 'audio')) return selected;
    }
    if (state.selection?.kind === 'clip') {
      const clip = state.project.clips.find((item) => item.id === state.selection.id);
      const selected = clip && state.project.assets.find((asset) => asset.id === clip.assetId);
      if (selected && (selected.kind === 'video' || selected.kind === 'audio')) return selected;
    }
    return state.project.assets.find((asset) => asset.kind === 'video' || asset.kind === 'audio');
  }

  function getReframeAsset() {
    if (state.selection?.kind === 'asset') {
      const selected = state.project.assets.find((asset) => asset.id === state.selection.id);
      if (selected?.kind === 'video') return selected;
    }
    if (state.selection?.kind === 'clip') {
      const clip = state.project.clips.find((item) => item.id === state.selection.id);
      const selected = clip && state.project.assets.find((asset) => asset.id === clip.assetId);
      if (selected?.kind === 'video') return selected;
    }
    return state.project.assets.find((asset) => asset.kind === 'video');
  }

  function persistReframeDraft() {
    try {
      if (!state.reframe.assetId || !state.reframe.keyframes.length) {
        localStorage.removeItem(REFRAME_DRAFT_KEY);
        return;
      }
      localStorage.setItem(REFRAME_DRAFT_KEY, JSON.stringify({
        assetId: state.reframe.assetId,
        sampleInterval: state.reframe.sampleInterval,
        method: state.reframe.method,
        status: state.reframe.status === 'applied' ? 'applied' : 'completed',
        keyframes: state.reframe.keyframes,
      }));
    } catch { /* Project editing remains available if draft persistence is unavailable. */ }
  }

  function renderReframeState(patch) {
    state.reframe = { ...state.reframe, ...patch };
    renderInspector();
    updatePreviewReframe();
  }

  function seekVideoFrame(video, time) {
    const target = clamp(time, 0, Math.max(0, video.duration - 0.04));
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.01) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('영상 프레임 탐색 시간이 초과되었습니다.'));
      }, 12000);
      const complete = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('분석할 영상 프레임을 읽지 못했습니다.')); };
      const cleanup = () => {
        clearTimeout(timeoutId);
        video.removeEventListener('seeked', complete);
        video.removeEventListener('error', failed);
      };
      video.addEventListener('seeked', complete, { once: true });
      video.addEventListener('error', failed, { once: true });
      video.currentTime = target;
    });
  }

  function visualFocusFromFrame(imageData, previousData) {
    const { data, width, height } = imageData;
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const luminance = (red + green + blue) / 3;
        const saturation = maximum - minimum;
        const motion = previousData
          ? (Math.abs(red - previousData[offset]) + Math.abs(green - previousData[offset + 1]) + Math.abs(blue - previousData[offset + 2])) / 3
          : 0;
        const leftOffset = x > 0 ? offset - 4 : offset;
        const leftLuminance = (data[leftOffset] + data[leftOffset + 1] + data[leftOffset + 2]) / 3;
        const edge = Math.abs(luminance - leftLuminance);
        const verticalBias = 0.82 + 0.18 * (1 - Math.abs(y / Math.max(1, height - 1) - 0.45));
        let weight = (motion * 1.7 + saturation * 0.75 + edge * 0.55) * verticalBias;
        if (luminance < 8) weight *= 0.12;
        weightedX += x * weight;
        weightedY += y * weight;
        totalWeight += weight;
      }
    }
    if (totalWeight < width * height * 0.5) return { x: 0.5, y: 0.45, confidence: 0.15, method: 'center' };
    return {
      x: clamp(weightedX / totalWeight / Math.max(1, width - 1), 0, 1),
      y: clamp(weightedY / totalWeight / Math.max(1, height - 1), 0, 1),
      confidence: clamp(totalWeight / (width * height * 55), 0.18, 0.82),
      method: 'visual',
    };
  }

  async function focusFromFrame(canvas, context, detector, previousData) {
    if (detector) {
      try {
        const faces = await detector.detect(canvas);
        if (faces.length) {
          const face = faces.sort((first, second) => second.boundingBox.width * second.boundingBox.height - first.boundingBox.width * first.boundingBox.height)[0];
          const box = face.boundingBox;
          return {
            x: clamp((box.x + box.width / 2) / canvas.width, 0, 1),
            y: clamp((box.y + box.height * 0.43) / canvas.height, 0, 1),
            confidence: 0.96,
            method: 'face',
            imageData: context.getImageData(0, 0, canvas.width, canvas.height),
          };
        }
      } catch { /* Fall back to visual saliency for this frame. */ }
    }
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return { ...visualFocusFromFrame(imageData, previousData?.data), imageData };
  }

  function smoothReframeKeyframes(keyframes) {
    return keyframes.map((keyframe, index) => {
      const previous = keyframes[Math.max(0, index - 1)];
      const next = keyframes[Math.min(keyframes.length - 1, index + 1)];
      const centerWeight = keyframe.method === 'face' ? 4 : 2;
      const denominator = centerWeight + 2;
      return {
        ...keyframe,
        x: clamp((previous.x + keyframe.x * centerWeight + next.x) / denominator, 0, 1),
        y: clamp((previous.y + keyframe.y * centerWeight + next.y) / denominator, 0, 1),
      };
    });
  }

  async function analyzeReframe() {
    const asset = getReframeAsset();
    if (state.shortform.analyzing || state.shortform.candidates.length) {
      renderReframeState({ status: 'failed', message: '숏폼 후보 분석 또는 검토를 먼저 완료하거나 취소하세요.' });
      return;
    }
    if (!asset) {
      renderReframeState({ status: 'failed', message: '자동 리프레임에는 영상 파일이 필요합니다.' });
      return;
    }
    const analysisVersion = state.reframe.analysisVersion + 1;
    const sampleInterval = state.reframe.sampleInterval;
    renderReframeState({
      analyzing: true, status: 'loading', progress: 0.03, message: `${asset.name} 프레임을 준비하고 있습니다.`,
      assetId: asset.id, analysisVersion, method: '', keyframes: [],
    });
    const isCancelled = () => state.reframe.analysisVersion !== analysisVersion;
    let objectUrl = '';
    try {
      const blob = await loadBlob(asset.id);
      if (!blob) throw new Error('원본 영상을 로컬 저장소에서 찾을 수 없습니다.');
      objectUrl = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = objectUrl;
      await waitFor(video, 'loadeddata');
      if (isCancelled()) return;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 180 / Math.max(1, video.videoWidth), 110 / Math.max(1, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const FaceDetectorClass = window.FaceDetector;
      let detector = null;
      if (FaceDetectorClass) {
        try { detector = new FaceDetectorClass({ fastMode: true, maxDetectedFaces: 4 }); } catch { detector = null; }
      }
      const duration = Math.max(0.1, Number.isFinite(video.duration) ? video.duration : asset.duration);
      const effectiveInterval = sampleInterval;
      const times = [];
      for (let time = 0; time < duration; time += effectiveInterval) times.push(Math.min(time, duration - 0.04));
      if (!times.length || duration - times.at(-1) > effectiveInterval * 0.35) times.push(Math.max(0, duration - 0.04));
      const keyframes = [];
      let previousData = null;
      for (let index = 0; index < times.length; index += 1) {
        if (isCancelled()) return;
        await seekVideoFrame(video, times[index]);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const focus = await focusFromFrame(canvas, context, detector, previousData);
        previousData = focus.imageData;
        keyframes.push({
          time: Number(times[index].toFixed(3)), x: focus.x, y: focus.y,
          confidence: focus.confidence, method: focus.method,
        });
        state.reframe.progress = 0.08 + ((index + 1) / times.length) * 0.88;
        state.reframe.message = `프레임 ${index + 1}/${times.length}에서 피사체를 추적하고 있습니다.`;
        renderInspector();
        await waitForAnalysisTurn();
      }
      if (isCancelled()) return;
      const smoothed = smoothReframeKeyframes(keyframes);
      const faceCount = smoothed.filter((keyframe) => keyframe.method === 'face').length;
      const method = faceCount === smoothed.length ? 'face' : faceCount ? 'hybrid' : 'visual';
      renderReframeState({
        analyzing: false, status: 'completed', progress: 1, method, keyframes: smoothed,
        message: `${smoothed.length}개 포커스 키프레임을 만들었습니다. 위치를 검토하고 적용하세요.`,
      });
      persistReframeDraft();
      renderToolbar();
      previewReframeKeyframe(0);
    } catch (reason) {
      if (isCancelled()) return;
      renderReframeState({
        analyzing: false, status: 'failed', progress: 1, keyframes: [],
        message: reason instanceof Error ? `리프레임 분석 실패: ${reason.message}` : '영상 프레임을 분석하지 못했습니다.',
      });
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (!isCancelled() && state.reframe.analyzing) {
        renderReframeState({ analyzing: false, status: 'failed', progress: 1, message: '리프레임 분석이 예기치 않게 종료되었습니다.' });
      }
    }
  }

  function previewReframeKeyframe(index) {
    const keyframe = state.reframe.keyframes[index];
    if (!keyframe) return;
    const clip = state.project.clips.find((item) => item.assetId === state.reframe.assetId
      && keyframe.time >= item.sourceStart && keyframe.time < item.sourceEnd);
    if (!clip) return;
    seek(clip.timelineStart + keyframe.time - clip.sourceStart);
  }

  function updateReframeKeyframe(index, axis, value, seekToFrame = false) {
    const keyframe = state.reframe.keyframes[index];
    if (!keyframe || (axis !== 'x' && axis !== 'y')) return;
    keyframe[axis] = clamp(Number(value) / 100, 0, 1);
    state.reframe.status = 'completed';
    state.reframe.message = '포커스 위치를 수정했습니다. 변경된 구도를 다시 적용하세요.';
    persistReframeDraft();
    renderToolbar();
    if (seekToFrame) previewReframeKeyframe(index);
    else updatePreviewReframe();
  }

  function updateReframeSetting(value) {
    const sampleInterval = clamp(Number(value), 0.5, 3);
    if (!Number.isFinite(sampleInterval)) return;
    state.reframe = {
      ...state.reframe, sampleInterval, analyzing: false, status: 'idle', progress: 0,
      message: state.reframe.keyframes.length ? '샘플 간격이 변경되었습니다. 다시 분석하세요.' : '',
      assetId: '', method: '', keyframes: [], analysisVersion: state.reframe.analysisVersion + 1,
    };
    persistReframeDraft();
    renderToolbar();
    renderInspector();
    syncPreview(true);
  }

  function clearReframeProposal() {
    state.reframe = {
      ...state.reframe, analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', method: '', keyframes: [],
      analysisVersion: state.reframe.analysisVersion + 1,
    };
    persistReframeDraft();
    renderToolbar();
    renderInspector();
    syncPreview(true);
  }

  function cancelReframeAnalysis() {
    if (!state.reframe.analyzing) return;
    state.reframe = {
      ...state.reframe, analyzing: false, status: 'cancelled', progress: 0,
      message: '자동 리프레임 분석을 취소했습니다.', assetId: '', method: '', keyframes: [],
      analysisVersion: state.reframe.analysisVersion + 1,
    };
    persistReframeDraft();
    renderToolbar();
    renderInspector();
    syncPreview(true);
  }

  function applyReframeProposal() {
    const asset = state.project.assets.find((item) => item.id === state.reframe.assetId && item.kind === 'video');
    if (!asset || !state.reframe.keyframes.length) {
      renderReframeState({ status: 'failed', message: '적용할 리프레임 키프레임이 없습니다.' });
      return;
    }
    const targetClipCount = state.project.clips.filter((clip) => clip.trackId === 'video' && clip.assetId === asset.id).length;
    if (!targetClipCount) {
      renderReframeState({ status: 'failed', message: '타임라인에 적용할 영상 클립이 없습니다.' });
      return;
    }
    const configuration = {
      enabled: true,
      targetRatio: '9:16',
      method: state.reframe.method,
      analyzedAt: new Date().toISOString(),
      keyframes: state.reframe.keyframes.map((keyframe) => ({
        time: keyframe.time,
        x: Number(keyframe.x.toFixed(4)),
        y: Number(keyframe.y.toFixed(4)),
        confidence: Number(keyframe.confidence.toFixed(3)),
        method: keyframe.method,
      })),
    };
    let appliedCount = 0;
    commit((project) => {
      project.canvas = { ...project.canvas, ratio: '9:16', ...ratios['9:16'] };
      const projectAsset = project.assets.find((item) => item.id === asset.id);
      if (projectAsset) projectAsset.reframe = clone(configuration);
      project.clips.forEach((clip) => {
        if (clip.trackId === 'video' && clip.assetId === asset.id) {
          clip.reframe = clone(configuration);
          appliedCount += 1;
        }
      });
      return project;
    });
    state.reframe = {
      ...state.reframe, analyzing: false, status: 'applied', progress: 1,
      message: `${asset.name}의 ${appliedCount}개 클립에 자동 리프레임을 적용했습니다. Undo로 복원할 수 있습니다.`,
    };
    persistReframeDraft();
    renderAll();
  }

  function removeAppliedReframe(assetId) {
    const affected = state.project.clips.filter((clip) => clip.assetId === assetId && clip.reframe?.enabled).length;
    if (!affected) return;
    commit((project) => {
      const projectAsset = project.assets.find((item) => item.id === assetId);
      if (projectAsset?.reframe) delete projectAsset.reframe;
      project.clips.forEach((clip) => {
        if (clip.assetId === assetId && clip.reframe) delete clip.reframe;
      });
      return project;
    });
    state.reframe = {
      ...state.reframe, status: 'idle', progress: 0, assetId: '', method: '', keyframes: [],
      message: `${affected}개 클립에서 자동 리프레임을 해제했습니다.`,
    };
    persistReframeDraft();
    renderAll();
  }

  async function apiPayload(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `요청에 실패했습니다. (${response.status})`);
    return payload;
  }

  function renderSttState(patch) {
    state.sttJob = { ...state.sttJob, ...patch };
    renderInspector();
  }

  async function startAutoCaption() {
    const asset = getTranscribableAsset();
    if (state.shortform.analyzing || state.shortform.candidates.length) {
      renderSttState({ message: '숏폼 후보 검토를 먼저 적용하거나 취소하세요.' });
      return;
    }
    if (!asset) {
      renderSttState({ message: '먼저 영상 또는 오디오 파일을 추가하세요.' });
      return;
    }
    if (location.protocol === 'file:') {
      renderSttState({ message: '자동 자막은 저장소에서 npm run dev로 실행해야 합니다.' });
      return;
    }
    renderSttState({
      active: true, status: 'uploading', progress: 0.08,
      message: `${asset.name} 업로드 중`, assetId: asset.id,
    });
    try {
      const media = await loadBlob(asset.id);
      if (!media) throw new Error('원본 미디어를 로컬 저장소에서 찾을 수 없습니다.');
      const response = await fetch('/api/stt/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': asset.mimeType || media.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(asset.name),
          'X-Asset-Id': asset.id,
          'X-Asset-Duration': String(asset.duration),
          'X-Language': state.ui.transcriptionLanguage,
        },
        body: media,
      });
      const job = await apiPayload(response);
      renderSttState({
        active: true, status: job.status, progress: job.progress,
        message: job.demo ? 'Demo STT가 자막 초안을 생성하고 있습니다.' : '음성을 인식하고 있습니다.',
        id: job.id, provider: job.provider, demo: Boolean(job.demo),
      });
      await pollSttJob(job.id);
    } catch (reason) {
      renderSttState({
        active: false, status: 'failed', progress: 1,
        message: reason instanceof Error ? reason.message : '자동 자막 요청에 실패했습니다.',
      });
    }
  }

  async function pollSttJob(jobId) {
    if (!state.sttJob.active || state.sttJob.id !== jobId) return;
    try {
      const job = await apiPayload(await fetch(`/api/stt/jobs/${jobId}`, { cache: 'no-store' }));
      if (job.status === 'completed') {
        clearTimeout(state.sttPollTimer);
        state.sttProposal = {
          assetId: state.sttJob.assetId,
          provider: job.provider,
          demo: Boolean(job.demo),
          language: job.result.language,
          segments: job.result.segments,
        };
        renderSttState({
          active: false, status: 'completed', progress: 1,
          message: `자막 제안 ${job.result.segments.length}개가 준비되었습니다.`,
        });
        return;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        clearTimeout(state.sttPollTimer);
        renderSttState({
          active: false, status: job.status, progress: 1,
          message: job.error || (job.status === 'cancelled' ? '자동 자막 작업을 취소했습니다.' : '자동 자막 생성에 실패했습니다.'),
        });
        return;
      }
      renderSttState({
        active: true, status: job.status, progress: Math.max(0.2, job.progress || 0),
        message: job.message || (job.status === 'queued' ? '작업 대기 중' : '음성을 분석하고 있습니다.'),
      });
      state.sttPollTimer = window.setTimeout(() => void pollSttJob(jobId), 350);
    } catch (reason) {
      clearTimeout(state.sttPollTimer);
      renderSttState({
        active: false, status: 'failed', progress: 1,
        message: reason instanceof Error ? reason.message : 'STT Job 상태를 확인하지 못했습니다.',
      });
    }
  }

  async function cancelAutoCaption() {
    clearTimeout(state.sttPollTimer);
    const jobId = state.sttJob.id;
    renderSttState({ active: false, status: 'cancelled', progress: 1, message: '자동 자막 작업을 취소했습니다.' });
    if (jobId) await fetch(`/api/stt/jobs/${jobId}`, { method: 'DELETE' }).catch(() => undefined);
  }

  function captionsFromSttProposal(proposal) {
    const clips = state.project.clips.filter((clip) => clip.assetId === proposal.assetId);
    if (!clips.length) return proposal.segments.map((segment) => captionFromCue({ ...segment, source: 'stt' }));
    return clips.flatMap((clip) => proposal.segments.flatMap((segment) => {
      const sourceStart = Math.max(segment.start, clip.sourceStart);
      const sourceEnd = Math.min(segment.end, clip.sourceEnd);
      if (sourceEnd <= sourceStart) return [];
      return [captionFromCue({
        ...segment,
        source: 'stt',
        start: clip.timelineStart + sourceStart - clip.sourceStart,
        end: clip.timelineStart + sourceEnd - clip.sourceStart,
      })];
    }));
  }

  function applySttProposal() {
    if (!state.sttProposal) return;
    const captions = captionsFromSttProposal(state.sttProposal);
    if (!captions.length) {
      renderSttState({ message: '현재 타임라인 범위에 적용할 자막 구간이 없습니다.' });
      return;
    }
    commit((project) => {
      project.texts.push(...captions);
      return project;
    });
    state.selection = { kind: 'text', id: captions[0].id };
    state.playhead = captions[0].start;
    state.captionMessage = `AI 자막 ${captions.length}개를 타임라인에 적용했습니다.`;
    state.sttProposal = null;
    state.sttJob = { active: false, status: 'idle', progress: 0, message: '', id: '', assetId: '', provider: '', demo: false };
    renderAll();
  }

  function dismissSttProposal() {
    const proposalAssetId = state.sttProposal?.assetId;
    const invalidatesShortform = proposalAssetId === state.shortform.assetId
      && (state.shortform.analyzing || state.shortform.candidates.some((candidate) => candidate.signalSource === 'stt'));
    state.sttProposal = null;
    if (invalidatesShortform) {
      clearShortformCandidates('원본 STT 제안이 취소되어 숏폼 후보도 초기화했습니다.');
    }
    renderSttState({ active: false, status: 'idle', progress: 0, message: 'AI 자막 제안을 적용하지 않았습니다.', id: '' });
  }

  function renderSilenceState(patch) {
    state.silence = { ...state.silence, ...patch };
    renderInspector();
  }

  function waitForAnalysisTurn() {
    return new Promise((resolve) => {
      let settled = false;
      let frameId = 0;
      let timerId = 0;
      const complete = () => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(frameId);
        clearTimeout(timerId);
        resolve();
      };
      frameId = requestAnimationFrame(complete);
      timerId = window.setTimeout(complete, 50);
    });
  }

  async function detectSilenceCandidates(audioBuffer, options, onProgress, isCancelled) {
    // Try Web Worker for off-main-thread analysis
    if (typeof Worker !== 'undefined') {
      try {
        return await detectSilenceInWorker(audioBuffer, options, onProgress, isCancelled);
      } catch (workerError) {
        // Fallback to main thread if Worker fails (e.g., file:// protocol)
        if (workerError?.name === 'AbortError') throw workerError;
      }
    }
    return detectSilenceMainThread(audioBuffer, options, onProgress, isCancelled);
  }

  function detectSilenceInWorker(audioBuffer, options, onProgress, isCancelled) {
    return new Promise((resolve, reject) => {
      let workerUrl;
      try {
        // Resolve worker URL relative to current module
        const scriptBase = import.meta.url || '';
        const base = scriptBase.substring(0, scriptBase.lastIndexOf('/') + 1);
        workerUrl = new URL('silence-worker.js', base).href;
      } catch {
        reject(new Error('Worker URL resolution failed'));
        return;
      }
      let worker;
      try {
        worker = new Worker(workerUrl);
      } catch {
        reject(new Error('Worker creation failed'));
        return;
      }
      const checkCancellation = setInterval(() => {
        if (isCancelled()) {
          clearInterval(checkCancellation);
          worker.terminate();
          const error = new Error('침묵 분석이 취소되었습니다.');
          error.name = 'AbortError';
          reject(error);
        }
      }, 200);
      worker.onmessage = (event) => {
        const { type } = event.data;
        if (type === 'progress') {
          onProgress(event.data.progress);
        } else if (type === 'result') {
          clearInterval(checkCancellation);
          worker.terminate();
          resolve(event.data.candidates);
        } else if (type === 'error') {
          clearInterval(checkCancellation);
          worker.terminate();
          reject(new Error(event.data.message));
        }
      };
      worker.onerror = (event) => {
        clearInterval(checkCancellation);
        worker.terminate();
        reject(new Error(event.message || 'Worker 실행 오류'));
      };
      // Transfer channel data to worker (zero-copy)
      const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => {
        const data = audioBuffer.getChannelData(index);
        return new Float32Array(data);
      });
      const transferables = channelData.map((data) => data.buffer);
      worker.postMessage({
        channelData,
        sampleRate: audioBuffer.sampleRate,
        thresholdDb: options.thresholdDb,
        minimumDuration: options.minimumDuration,
        padding: options.padding,
      }, transferables);
    });
  }

  async function detectSilenceMainThread(audioBuffer, options, onProgress, isCancelled) {
    const { thresholdDb, minimumDuration, padding } = options;
    const threshold = 10 ** (thresholdDb / 20);
    const frameDuration = 0.025;
    const frameSize = Math.max(1, Math.round(audioBuffer.sampleRate * frameDuration));
    const sampleStride = Math.max(1, Math.floor(audioBuffer.sampleRate / 8000));
    const frameCount = Math.ceil(audioBuffer.length / frameSize);
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
    const rawRanges = [];
    let silentStart = null;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const startSample = frameIndex * frameSize;
      const endSample = Math.min(audioBuffer.length, startSample + frameSize);
      let squaredTotal = 0;
      let sampleCount = 0;
      for (const channel of channels) {
        for (let sample = startSample; sample < endSample; sample += sampleStride) {
          squaredTotal += channel[sample] * channel[sample];
          sampleCount += 1;
        }
      }
      const rms = sampleCount ? Math.sqrt(squaredTotal / sampleCount) : 0;
      const frameStart = startSample / audioBuffer.sampleRate;
      const frameEnd = endSample / audioBuffer.sampleRate;
      if (rms <= threshold) {
        if (silentStart === null) silentStart = frameStart;
      } else if (silentStart !== null) {
        rawRanges.push({ start: silentStart, end: frameStart });
        silentStart = null;
      }
      if (frameIndex % 800 === 0) {
        if (isCancelled()) {
          const error = new Error('침묵 분석이 취소되었습니다.');
          error.name = 'AbortError';
          throw error;
        }
        onProgress(frameIndex / Math.max(1, frameCount));
        await waitForAnalysisTurn();
      }
      if (frameIndex === frameCount - 1 && silentStart !== null) {
        rawRanges.push({ start: silentStart, end: frameEnd });
      }
    }

    return rawRanges
      .filter((range) => range.end - range.start >= minimumDuration)
      .map((range, index) => ({
        id: `silence-${index}-${Math.round(range.start * 1000)}`,
        start: range.start,
        end: range.end,
        removeStart: range.start + padding,
        removeEnd: range.end - padding,
        selected: range.end - range.start > padding * 2 + 0.04,
      }))
      .filter((range) => range.removeEnd - range.removeStart > 0.04);
  }

  async function analyzeSilence() {
    const asset = getTranscribableAsset();
    if (state.shortform.analyzing || state.shortform.candidates.length) {
      renderSilenceState({ status: 'failed', message: '숏폼 후보 분석 또는 검토를 먼저 완료하거나 취소하세요.' });
      return;
    }
    if (!asset) {
      renderSilenceState({ status: 'failed', message: '먼저 영상 또는 오디오 파일을 추가하세요.' });
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      renderSilenceState({ status: 'failed', message: '이 브라우저는 오디오 분석을 지원하지 않습니다.' });
      return;
    }
    const analysisVersion = state.silence.analysisVersion + 1;
    const options = {
      thresholdDb: state.silence.thresholdDb,
      minimumDuration: state.silence.minimumDuration,
      padding: state.silence.padding,
    };
    renderSilenceState({
      analyzing: true, status: 'loading', progress: 0.04, message: `${asset.name} 오디오를 준비하고 있습니다.`,
      assetId: asset.id, analysisVersion, candidates: [],
    });
    let audioContext = null;
    let lastRenderedProgressStep = -1;
    const isCancelled = () => state.silence.analysisVersion !== analysisVersion;
    try {
      audioContext = new AudioContextClass();
      const blob = await loadBlob(asset.id);
      if (isCancelled()) return;
      if (!blob) throw new Error('원본 미디어를 로컬 저장소에서 찾을 수 없습니다.');
      let audioBuffer;
      try {
        audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
      } catch {
        // Browser can't decode (e.g., HEVC MOV) — try server-side FFmpeg extraction
        renderSilenceState({ progress: 0.06, message: '서버에서 오디오를 추출하고 있습니다.' });
        if (isCancelled()) return;
        try {
          const extractResponse = await fetch('/api/audio/extract', {
            method: 'POST',
            headers: { 'Content-Type': blob.type || 'video/mp4' },
            body: blob,
          });
          if (!extractResponse.ok) throw new Error(`서버 오디오 추출 실패 (${extractResponse.status})`);
          const wavBuffer = await extractResponse.arrayBuffer();
          if (isCancelled()) return;
          audioBuffer = await audioContext.decodeAudioData(wavBuffer);
        } catch (serverError) {
          throw new Error(`오디오 디코딩 실패: 브라우저와 서버 모두 이 미디어를 분석할 수 없습니다. (${serverError?.message || '알 수 없는 오류'})`);
        }
      }
      if (isCancelled()) return;
      renderSilenceState({ status: 'analyzing', progress: 0.12, message: 'RMS 음량을 분석하고 있습니다.' });
      const candidates = await detectSilenceCandidates(audioBuffer, options, (progress) => {
        if (isCancelled()) return;
        state.silence.progress = 0.12 + progress * 0.82;
        const progressStep = Math.floor(progress * 5);
        if (progressStep > lastRenderedProgressStep) {
          lastRenderedProgressStep = progressStep;
          renderInspector();
        }
      }, isCancelled);
      if (isCancelled()) return;
      renderSilenceState({
        analyzing: false, status: 'completed', progress: 1, candidates,
        message: candidates.length
          ? `침묵 후보 ${candidates.length}개를 찾았습니다. 삭제할 구간을 검토하세요.`
          : '현재 설정에 맞는 침묵 구간을 찾지 못했습니다.',
      });
    } catch (reason) {
      if (isCancelled()) return;
      renderSilenceState({
        analyzing: false, status: 'failed', progress: 1, candidates: [],
        message: reason instanceof Error ? `오디오 분석 실패: ${reason.message}` : '오디오를 분석하지 못했습니다.',
      });
    } finally {
      if (audioContext) await audioContext.close().catch(() => undefined);
      if (!isCancelled() && state.silence.analyzing) {
        renderSilenceState({ analyzing: false, status: 'failed', progress: 1, message: '오디오 분석이 예기치 않게 종료되었습니다.' });
      }
    }
  }

  function mergeTimeRanges(ranges) {
    return ranges
      .filter((range) => range.end - range.start > 0.001)
      .sort((first, second) => first.start - second.start)
      .reduce((merged, range) => {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end + 0.001) previous.end = Math.max(previous.end, range.end);
        else merged.push({ start: range.start, end: range.end });
        return merged;
      }, []);
  }

  function subtractTimeRanges(start, end, removals) {
    const kept = [];
    let cursor = start;
    for (const removal of removals) {
      if (removal.end <= cursor) continue;
      if (removal.start >= end) break;
      if (removal.start > cursor) kept.push({ start: cursor, end: Math.min(end, removal.start) });
      cursor = Math.max(cursor, Math.min(end, removal.end));
      if (cursor >= end) break;
    }
    if (cursor < end) kept.push({ start: cursor, end });
    return kept.filter((range) => range.end - range.start > 0.001);
  }

  function mapTimeAfterRemovals(time, removals) {
    let removedBefore = 0;
    for (const removal of removals) {
      if (time >= removal.end) {
        removedBefore += removal.end - removal.start;
        continue;
      }
      if (time > removal.start) return removal.start - removedBefore;
      break;
    }
    return time - removedBefore;
  }

  function timelineRemovalsForSilences(assetId, candidates) {
    const sourceRanges = candidates.map((candidate) => ({ start: candidate.removeStart, end: candidate.removeEnd }));
    const timelineRanges = state.project.clips
      .filter((clip) => clip.assetId === assetId)
      .flatMap((clip) => sourceRanges.flatMap((range) => {
        const sourceStart = Math.max(clip.sourceStart, range.start);
        const sourceEnd = Math.min(clip.sourceEnd, range.end);
        if (sourceEnd - sourceStart <= 0.001) return [];
        return [{
          start: clip.timelineStart + sourceStart - clip.sourceStart,
          end: clip.timelineStart + sourceEnd - clip.sourceStart,
        }];
      }));
    return mergeTimeRanges(timelineRanges);
  }

  function previewSilenceCandidate(index, occurrenceIndex = 0) {
    const candidate = state.silence.candidates[index];
    if (!candidate) return;
    const occurrences = timelineRemovalsForSilences(state.silence.assetId, [candidate]);
    const occurrence = occurrences[occurrenceIndex];
    if (!occurrence) return;
    seek(occurrence.start);
  }

  function toggleSilenceCandidate(index, selected) {
    const candidate = state.silence.candidates[index];
    if (!candidate) return;
    candidate.selected = selected;
    renderInspector();
  }

  function clearSilenceCandidates() {
    if (state.shortform.analyzing || state.shortform.candidates.length) {
      invalidateShortformReview('침묵 후보가 변경되어 숏폼 후보를 다시 생성해야 합니다.');
    }
    renderSilenceState({
      analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', candidates: [],
      analysisVersion: state.silence.analysisVersion + 1,
    });
  }

  function applySilenceRemoval() {
    const analysisAsset = state.project.assets.find((asset) => asset.id === state.silence.assetId);
    const candidates = state.silence.candidates.filter((candidate) => candidate.selected);
    const removals = timelineRemovalsForSilences(state.silence.assetId, candidates);
    if (!analysisAsset) {
      clearSilenceCandidates();
      renderSilenceState({ status: 'failed', message: '분석한 미디어가 삭제되었습니다. 다른 미디어를 다시 분석하세요.' });
      return;
    }
    if (!candidates.length || !removals.length) {
      renderSilenceState({ message: '타임라인에서 제거할 침묵 후보를 선택하세요.' });
      return;
    }
    const removedDuration = removals.reduce((total, range) => total + range.end - range.start, 0);
    const firstRemovalStart = removals[0].start;
    commit((project) => {
      project.clips = project.clips.flatMap((clip) => {
        const clipStart = clip.timelineStart;
        const clipEnd = clip.timelineStart + clip.sourceEnd - clip.sourceStart;
        return subtractTimeRanges(clipStart, clipEnd, removals).map((range, index) => {
          return {
            ...clip,
            id: index === 0 ? clip.id : uid(),
            timelineStart: mapTimeAfterRemovals(range.start, removals),
            sourceStart: clip.sourceStart + range.start - clipStart,
            sourceEnd: clip.sourceStart + range.end - clipStart,
          };
        });
      });
      // Snap adjacent clips to eliminate micro-gaps (floating point drift)
      const tracks = ['video', 'audio'];
      for (const trackId of tracks) {
        const trackClips = project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.timelineStart - b.timelineStart);
        for (let i = 1; i < trackClips.length; i++) {
          const prevEnd = trackClips[i - 1].timelineStart + (trackClips[i - 1].sourceEnd - trackClips[i - 1].sourceStart);
          const gap = trackClips[i].timelineStart - prevEnd;
          if (gap > 0 && gap < 0.05) {
            trackClips[i].timelineStart = prevEnd;
          }
        }
      }
      project.texts = project.texts.flatMap((text) => {
        const kept = subtractTimeRanges(text.start, text.end, removals);
        if (!kept.length) return [];
        return kept.map((range, index) => ({
          ...text,
          id: index === 0 ? text.id : uid(),
          start: mapTimeAfterRemovals(range.start, removals),
          end: mapTimeAfterRemovals(range.end, removals),
        }));
      });
      return project;
    });
    state.playhead = mapTimeAfterRemovals(firstRemovalStart, removals);
    state.selection = null;
    state.silence = {
      ...state.silence, analyzing: false, status: 'applied', progress: 1, candidates: [],
      message: `${removals.length}개 구간, 총 ${removedDuration.toFixed(2)}초를 리플 삭제했습니다. Undo로 복원할 수 있습니다.`,
    };
    renderAll();
  }

  function updateSilenceSetting(field, value) {
    const limits = {
      thresholdDb: [-80, -5], minimumDuration: [0.1, 10], padding: [0, 2],
    };
    const [minimum, maximum] = limits[field] || [0, 1];
    const numericValue = clamp(Number(value), minimum, maximum);
    if (!Number.isFinite(numericValue)) return;
    if (state.shortform.analyzing || state.shortform.candidates.length) {
      invalidateShortformReview('침묵 분석 설정이 변경되어 숏폼 후보를 다시 생성해야 합니다.');
    }
    const hadReview = state.silence.analyzing || state.silence.candidates.length > 0;
    state.silence = {
      ...state.silence, [field]: numericValue, analyzing: false, status: 'idle', progress: 0, assetId: '', candidates: [],
      analysisVersion: state.silence.analysisVersion + 1,
      message: hadReview ? '설정이 변경되었습니다. 다시 분석하세요.' : '',
    };
    renderInspector();
  }

  function addText() {
    const id = uid();
    commit((project) => { project.texts.push({ id, role: 'text', text: '텍스트를 입력하세요', start: state.playhead, end: Math.min(project.duration, state.playhead + 4), x: 50, y: 76, fontSize: 56, fontWeight: 800, fontFamily: 'sans-serif', opacity: 1, boxWidth: 88, color: '#ffffff', background: '#00000099', align: 'center', keyframes: [] }); return project; });
    state.selection = { kind: 'text', id }; renderAll();
  }

  function downloadJson() {
    downloadBlob(new Blob([JSON.stringify(persistable(state.project), null, 2)], { type: 'application/json' }), `${safeName(state.project.title)}.json`);
  }

  function downloadStandaloneApp() {
    const source = `<!doctype html>\n${document.documentElement.outerHTML}`;
    downloadBlob(new Blob([source], { type: 'text/html;charset=utf-8' }), 'shortform-studio.html');
  }

  const safeName = (name) => name.replace(/[^a-zA-Z0-9가-힣-_]/g, '-') || 'shortform';
  function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  let exportController = null;
  let exportRunVersion = 0;

  async function refreshRenderCapability(force = false) {
    if (state.exportCapability.loading || (state.exportCapability.checked && state.exportCapability.available && !force)) return;
    if (location.protocol === 'file:') {
      state.exportCapability = {
        checked: true, loading: false, available: false,
        message: 'MP4는 npm run dev로 서버를 실행할 때 사용할 수 있습니다.',
      };
      state.exportFormat = 'webm';
      renderModal();
      return;
    }
    state.exportCapability = { ...state.exportCapability, loading: true };
    renderModal();
    try {
      const capability = await apiPayload(await fetch('/api/render/health', { cache: 'no-store' }));
      state.exportCapability = {
        checked: true, loading: false, available: Boolean(capability.available),
        message: capability.message || (capability.available ? '서버 MP4 렌더링을 사용할 수 있습니다.' : '서버 MP4 렌더링을 사용할 수 없습니다.'),
      };
      if (!capability.available) state.exportFormat = 'webm';
    } catch (reason) {
      state.exportCapability = {
        checked: true, loading: false, available: false,
        message: reason instanceof Error ? reason.message : 'MP4 렌더 서버에 연결하지 못했습니다.',
      };
      state.exportFormat = 'webm';
    }
    renderModal();
  }

  async function exportMp4(quality, signal) {
    if (!state.exportCapability.available) throw new Error(state.exportCapability.message);
    const usedIds = [...new Set(state.project.clips.map((clip) => clip.assetId))];
    const usedAssets = usedIds.map((id) => state.project.assets.find((asset) => asset.id === id)).filter(Boolean);
    for (let index = 0; index < usedAssets.length; index += 1) {
      if (signal.aborted) throw new DOMException('내보내기가 취소되었습니다.', 'AbortError');
      const asset = usedAssets[index];
      updateExport(0.02 + index / Math.max(1, usedAssets.length) * 0.16, `원본 업로드 ${index + 1}/${usedAssets.length}`);
      const media = await loadBlob(asset.id);
      if (!media) throw new Error(`${asset.name} 원본을 로컬 저장소에서 찾을 수 없습니다.`);
      await apiPayload(await fetch(`/api/render/assets/${encodeURIComponent(asset.id)}`, {
        method: 'POST',
        headers: {
          'Content-Type': asset.mimeType || media.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(asset.name),
        },
        body: media,
        signal,
      }));
    }

    updateExport(0.2, 'MP4 렌더 Job 생성 중');
    const requestedJobId = uid();
    updateExport(0.2, 'MP4 렌더 Job 생성 중', { jobId: requestedJobId });
    const job = await apiPayload(await fetch('/api/render/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: requestedJobId, project: persistable(state.project), quality }),
      signal,
    }));
    updateExport(0.2, job.phase || '렌더 대기 중', { jobId: job.id });

    while (!signal.aborted) {
      const current = await apiPayload(await fetch(`/api/render/jobs/${job.id}`, { cache: 'no-store', signal }));
      updateExport(0.2 + Math.max(0, Math.min(1, current.progress || 0)) * 0.78, current.phase || 'MP4 렌더링 중', { jobId: job.id });
      if (current.status === 'completed') {
        updateExport(0.99, 'MP4 결과 다운로드 중', { jobId: job.id });
        const response = await fetch(current.result.url, { cache: 'no-store', signal });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `MP4 결과를 받지 못했습니다. (${response.status})`);
        }
        return { blob: await response.blob(), fileName: current.result.fileName || `${safeName(state.project.title)}.mp4` };
      }
      if (current.status === 'failed' || current.status === 'cancelled') {
        throw new Error(current.error || (current.status === 'cancelled' ? 'MP4 렌더링이 취소되었습니다.' : 'MP4 렌더링에 실패했습니다.'));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    }
    throw new DOMException('내보내기가 취소되었습니다.', 'AbortError');
  }

  async function startExport(quality) {
    const format = state.exportFormat === 'mp4' && state.exportCapability.available ? 'mp4' : 'webm';
    const runVersion = ++exportRunVersion;
    exportController = new AbortController();
    state.exportError = '';
    state.exportProgress = { active: true, progress: 0, status: '내보내기 준비 중', jobId: '', format };
    state.playing = false;
    syncPreview();
    renderModal();
    try {
      if (format === 'mp4') {
        const result = await exportMp4(quality, exportController.signal);
        if (runVersion !== exportRunVersion) return;
        downloadBlob(result.blob, result.fileName);
      } else {
        const blob = await exportVideo(quality, exportController.signal);
        if (runVersion !== exportRunVersion) return;
        downloadBlob(blob, `${safeName(state.project.title)}.webm`);
      }
      state.exportProgress = { active: false, progress: 1, status: '완료', jobId: '', format };
      state.exportOpen = false;
      renderModal();
    } catch (reason) {
      if (runVersion !== exportRunVersion) return;
      const jobId = state.exportProgress.jobId;
      if (jobId) void fetch(`/api/render/jobs/${jobId}`, { method: 'DELETE' }).catch(() => undefined);
      state.exportProgress = { active: false, progress: 0, status: '', jobId: '', format: '' };
      state.exportError = reason?.name === 'AbortError'
        ? '내보내기를 취소했습니다.'
        : reason instanceof Error ? reason.message : '내보내기에 실패했습니다.';
      renderModal();
    } finally {
      if (runVersion === exportRunVersion) exportController = null;
    }
  }

  async function cancelExport() {
    if (!state.exportProgress.active) return;
    const jobId = state.exportProgress.jobId;
    const format = state.exportProgress.format;
    exportRunVersion += 1;
    exportController?.abort();
    exportController = null;
    state.exportProgress = { active: false, progress: 0, status: '취소됨', jobId: '', format: '' };
    state.exportError = format === 'mp4' ? 'MP4 내보내기를 취소했습니다.' : 'WebM 내보내기를 취소했습니다.';
    renderModal();
    if (jobId) await fetch(`/api/render/jobs/${jobId}`, { method: 'DELETE' }).catch(() => undefined);
  }

  function drawCover(context, source, sourceWidth, sourceHeight, width, height, focus = { x: 0.5, y: 0.5 }) {
    const sourceRatio = sourceWidth / Math.max(1, sourceHeight);
    const targetRatio = width / Math.max(1, height);
    let sourceX = 0;
    let sourceY = 0;
    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    if (sourceRatio > targetRatio) {
      cropWidth = sourceHeight * targetRatio;
      sourceX = clamp(focus.x * sourceWidth - cropWidth / 2, 0, sourceWidth - cropWidth);
    } else if (sourceRatio < targetRatio) {
      cropHeight = sourceWidth / targetRatio;
      sourceY = clamp(focus.y * sourceHeight - cropHeight / 2, 0, sourceHeight - cropHeight);
    }
    context.drawImage(source, sourceX, sourceY, cropWidth, cropHeight, 0, 0, width, height);
  }

  function drawText(context, text, scale, width, height, time) {
    const kf = (text.keyframes && text.keyframes.length && time !== undefined) ? interpolateTextKeyframes(text, time) : { x: text.x, y: text.y, fontSize: text.fontSize, opacity: text.opacity ?? 1 };
    const x = width*kf.x/100, y = height*kf.y/100, size = Math.round(kf.fontSize*scale);
    const opacity = clamp(kf.opacity, 0, 1);
    context.globalAlpha = opacity;
    context.font = `${text.fontWeight} ${size}px ${text.fontFamily || 'sans-serif'}`; context.textAlign = text.align; context.textBaseline = 'middle';
    const metrics = context.measureText(text.text); const padding = size*.22;
    let left = x-metrics.width/2; if (text.align === 'left') left=x; if (text.align === 'right') left=x-metrics.width;
    context.fillStyle=text.background; context.fillRect(left-padding,y-size*.7,metrics.width+padding*2,size*1.4); context.fillStyle=text.color; context.fillText(text.text,x,y);
    context.globalAlpha = 1;
  }

  async function exportVideo(quality, signal) {
    if (!window.MediaRecorder) throw new Error('이 브라우저는 영상 내보내기를 지원하지 않습니다.');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const base = quality === 'hd' ? 1080 : 540;
    const vertical = state.project.canvas.height >= state.project.canvas.width;
    const width = vertical ? base : Math.round(base * state.project.canvas.width / state.project.canvas.height);
    const height = vertical ? Math.round(base * state.project.canvas.height / state.project.canvas.width) : base;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    const elements = new Map();
    const audioElements = new Map();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = AudioContextClass ? new AudioContextClass() : null;
    const audioDestination = audioContext?.createMediaStreamDestination();
    if (audioContext) await audioContext.resume();

    updateExport(0, '미디어 준비 중');
    for (const asset of state.project.assets.filter((item) => item.url)) {
      if (asset.kind === 'image') {
        const image = new Image(); image.src = asset.url;
        await waitFor(image, 'load'); elements.set(asset.id, image);
      } else if (asset.kind === 'video') {
        const video = document.createElement('video');
        video.src = asset.url; video.preload = 'auto'; video.playsInline = true;
        await waitFor(video, 'loadedmetadata'); elements.set(asset.id, video);
        if (audioContext && audioDestination) audioContext.createMediaElementSource(video).connect(audioDestination);
      } else {
        const audio = document.createElement('audio');
        audio.src = asset.url; audio.preload = 'auto';
        await waitFor(audio, 'loadedmetadata'); audioElements.set(asset.id, audio);
        if (audioContext && audioDestination) audioContext.createMediaElementSource(audio).connect(audioDestination);
      }
    }

    const canvasStream = canvas.captureStream(30);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(audioDestination?.stream.getAudioTracks() || []),
    ]);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((type) => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(new Error('영상 인코딩 중 오류가 발생했습니다.'));
    });
    recorder.start(1000);
    const started = performance.now();
    let activeId = '';
    let activeAudioId = '';

    await new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      const frame = () => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const time = Math.min(state.project.duration, (performance.now() - started) / 1000);
        context.fillStyle = state.project.canvas.background;
        context.fillRect(0, 0, width, height);
        const clip = state.project.clips.find((item) => item.trackId === 'video' && time >= item.timelineStart && time < item.timelineStart + clipDuration(item));
        for (const [id, element] of elements) {
          if (element instanceof HTMLVideoElement && id !== clip?.assetId) element.pause();
        }
        if (clip) {
          const trans = transitionProgress(clip, time);
          if (trans && (trans.type === 'fade' || trans.type === 'dissolve')) context.globalAlpha = trans.progress;
          const element = elements.get(clip.assetId);
          if (element instanceof HTMLVideoElement) {
            const expected = clipSourceTime(clip, time);
            if (activeId !== clip.id || Math.abs(element.currentTime - expected) > .35) element.currentTime = expected;
            element.volume = clipVolume(clip, time);
            if (element.paused) void element.play();
            if (element.readyState >= 2) {
              const focus = clip.reframe?.enabled ? focusAtSourceTime(clip.reframe, expected) : { x: 0.5, y: 0.5 };
              if (trans && trans.type.startsWith('wipe')) {
                const wipeX = trans.type === 'wipe-left' ? width * trans.progress : width * (1 - trans.progress);
                context.save(); context.beginPath(); context.rect(trans.type === 'wipe-left' ? 0 : wipeX, 0, trans.type === 'wipe-left' ? wipeX : width - wipeX, height); context.clip();
                drawCover(context, element, element.videoWidth, element.videoHeight, width, height, focus);
                context.restore();
              } else {
                drawCover(context, element, element.videoWidth, element.videoHeight, width, height, focus);
              }
            }
            activeId = clip.id;
          } else if (element) drawCover(context, element, element.naturalWidth, element.naturalHeight, width, height);
          context.globalAlpha = 1;
        }

        const audioClip = state.project.clips.find((item) => item.trackId === 'audio' && time >= item.timelineStart && time < item.timelineStart + clipDuration(item));
        const activeVideoElement = clip && elements.get(clip.assetId);
        if (activeVideoElement instanceof HTMLVideoElement) activeVideoElement.muted = Boolean(audioClip);
        for (const [id, element] of audioElements) {
          if (id !== audioClip?.assetId) element.pause();
        }
        if (audioClip) {
          const element = audioElements.get(audioClip.assetId);
          if (element) {
            const expected = clipSourceTime(audioClip, time);
            if (activeAudioId !== audioClip.id || Math.abs(element.currentTime - expected) > .35) element.currentTime = expected;
            element.volume = clipVolume(audioClip, time);
            if (element.paused) void element.play();
            activeAudioId = audioClip.id;
          }
        }

        state.project.texts.filter((text) => time >= text.start && time <= text.end)
          .forEach((text) => drawText(context, text, width / state.project.canvas.width, width, height, time));
        updateExport(time / state.project.duration, `렌더링 ${Math.round(time / state.project.duration * 100)}%`);
        if (time >= state.project.duration) { signal?.removeEventListener('abort', onAbort); resolve(); } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    elements.forEach((element) => element.pause?.());
    audioElements.forEach((element) => element.pause());
    recorder.stop(); await stopped;
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext) await audioContext.close();
    return new Blob(chunks, { type: mime || 'video/webm' });
  }

  function updateExport(progress, status, patch = {}) {
    state.exportProgress = { ...state.exportProgress, active: true, progress, status, ...patch };
    renderModal();
  }

  function bindEvents() {
    document.getElementById('pickFiles').onclick = () => document.getElementById('fileInput').click();
    document.getElementById('fileInput').onchange = (event) => { void addFiles([...event.target.files]); event.target.value=''; };
    document.getElementById('captionInput').onchange = (event) => { const [file] = event.target.files; if (file) void importCaptions(file); event.target.value=''; };
    const drop = document.getElementById('dropZone');
    drop.ondragover=(event)=>{event.preventDefault();drop.classList.add('is-dragging');}; drop.ondragleave=()=>drop.classList.remove('is-dragging');
    drop.ondrop=(event)=>{event.preventDefault();drop.classList.remove('is-dragging');void addFiles([...event.dataTransfer.files]);};
    document.getElementById('projectTitle').onchange=(event)=>commit((project)=>({...project,title:event.target.value}));
    document.getElementById('saveIndicator').onclick=()=>{localStorage.setItem(STORAGE_KEY,JSON.stringify(persistable(state.project)));state.saveStatus='saved';renderSaveStatus();};
    document.getElementById('undoButton').onclick=undo; document.getElementById('redoButton').onclick=redo;
    document.getElementById('addTextButton').onclick=addText;
    document.getElementById('appMenuButton').onclick=(event)=>{event.stopPropagation();toggleAppMenu();};
    document.getElementById('settingsButton').onclick=openSettings;
    document.getElementById('appMenu').onclick=(event)=>{
      const action = event.target.closest('[data-menu-action]')?.dataset.menuAction;
      if (!action) return;
      if (action === 'import-media') document.getElementById('fileInput').click();
      else if (action === 'import-captions') document.getElementById('captionInput').click();
      else if (action === 'download-app') downloadStandaloneApp();
      else if (action === 'export-json') downloadJson();
      else if (action === 'undo') undo();
      else if (action === 'redo') redo();
      else if (action === 'split') splitSelected();
      else if (action === 'delete') deleteSelection();
      else if (action === 'toggle-library') updateUiPreferences({ libraryVisible: !state.ui.libraryVisible });
      else if (action === 'toggle-inspector') updateUiPreferences({ inspectorVisible: !state.ui.inspectorVisible });
      else if (action === 'toggle-timeline') updateUiPreferences({ timelineVisible: !state.ui.timelineVisible });
      toggleAppMenu(false);
      renderToolbar();
    };
    document.getElementById('backButton').onclick=()=>seek(state.playhead-1);document.getElementById('forwardButton').onclick=()=>seek(state.playhead+1);document.getElementById('playButton').onclick=togglePlayback;
    document.getElementById('zoomInput').oninput=(event)=>{state.zoom=Number(event.target.value);renderTimeline();};
    document.getElementById('exportButton').onclick=()=>{if(hasPendingReframe())return;state.settingsOpen=false;state.exportOpen=true;state.exportError='';renderModal();void refreshRenderCapability();};

    document.getElementById('assetList').onclick=(event)=>{const add=event.target.closest('[data-add-asset]'),remove=event.target.closest('[data-remove-asset]'),select=event.target.closest('[data-select-asset]');if(add){event.stopPropagation();addAssetToTimeline(add.dataset.addAsset);}else if(remove){event.stopPropagation();void removeAsset(remove.dataset.removeAsset);}else if(select){state.selection={kind:'asset',id:select.dataset.selectAsset};renderAll();}};
    document.getElementById('textLayer').onclick=(event)=>{const target=event.target.closest('[data-select-text]');if(target){state.selection={kind:'text',id:target.dataset.selectText};renderAll();}};
    const timeline=document.getElementById('timelineScroll');
    timeline.onclick=(event)=>{const clip=event.target.closest('[data-select-clip]'),text=event.target.closest('[data-select-text]');if(clip){const kind='clip',id=clip.dataset.selectClip;if(event.ctrlKey||event.metaKey)selectToggle(kind,id);else if(event.shiftKey)selectAdd(kind,id);else selectSingle(kind,id);renderAll();return;}if(text){const kind='text',id=text.dataset.selectText;if(event.ctrlKey||event.metaKey)selectToggle(kind,id);else if(event.shiftKey)selectAdd(kind,id);else selectSingle(kind,id);renderAll();return;}const rect=timeline.getBoundingClientRect();seek((event.clientX-rect.left+timeline.scrollLeft-LABEL_WIDTH)/state.zoom);};
    timeline.ondragstart=(event)=>{const clip=event.target.closest('[data-select-clip]');if(clip)state.draggedClip=clip.dataset.selectClip;};
    timeline.ondragover=(event)=>event.preventDefault();timeline.ondrop=(event)=>{const target=event.target.closest('[data-select-clip]');if(!target||!state.draggedClip)return;const sourceId=state.draggedClip,targetId=target.dataset.selectClip;commit((project)=>{const source=project.clips.find((c)=>c.id===sourceId),destination=project.clips.find((c)=>c.id===targetId);if(!source||!destination||source.trackId!==destination.trackId)return project;const ordered=project.clips.filter((c)=>c.trackId===source.trackId).sort((a,b)=>a.timelineStart-b.timelineStart);const from=ordered.findIndex((c)=>c.id===sourceId),to=ordered.findIndex((c)=>c.id===targetId);ordered.splice(to,0,ordered.splice(from,1)[0]);let cursor=0;ordered.forEach((c)=>{c.timelineStart=cursor;cursor+=c.sourceEnd-c.sourceStart;});return project;});state.draggedClip='';};
    timeline.onpointerdown=(event)=>{const handle=event.target.closest('[data-trim]');if(!handle)return;event.preventDefault();event.stopPropagation();const clip=state.project.clips.find((item)=>item.id===handle.dataset.clip);if(!clip)return;const startX=event.clientX,startSource=clip.sourceStart,endSource=clip.sourceEnd,startTimeline=clip.timelineStart;window.addEventListener('pointerup',(up)=>{const delta=(up.clientX-startX)/state.zoom;commit((project)=>{const current=project.clips.find((item)=>item.id===clip.id);if(!current)return project;if(handle.dataset.trim==='start'){const bounded=Math.max(-startSource,Math.min(endSource-startSource-.1,delta));current.sourceStart=startSource+bounded;current.timelineStart=startTimeline+bounded;}else current.sourceEnd=Math.max(startSource+.1,endSource+delta);return project;});},{once:true});};

    document.getElementById('inspectorContent').onchange=(event)=>{
      const target = event.target;
      if (target.dataset.llmPreference !== undefined) updateLlmPreference(target.checked);
      else if (target.dataset.shortformTarget !== undefined) updateShortformTarget(target.value);
      else if (target.dataset.reframeSetting) updateReframeSetting(target.value);
      else if (target.dataset.reframeKeyframe !== undefined) {
        updateReframeKeyframe(Number(target.dataset.reframeKeyframe), target.dataset.reframeAxis, target.value, true);
        renderInspector();
      } else if (target.dataset.silenceCandidate !== undefined) toggleSilenceCandidate(Number(target.dataset.silenceCandidate), target.checked);
      else if (target.dataset.silenceField) updateSilenceSetting(target.dataset.silenceField, target.value);
      else handleInspectorChange(target);
    };
    document.getElementById('inspectorContent').oninput=(event)=>{
      const target = event.target;
      if (target.dataset.reframeKeyframe !== undefined) {
        updateReframeKeyframe(Number(target.dataset.reframeKeyframe), target.dataset.reframeAxis, target.value);
        const label = target.closest('label')?.querySelector('span');
        if (label) label.textContent = `가로 ${Math.round(Number(target.value))}%`;
      } else if(target.type==='range'||target.type==='color'||target.type==='number') {
        handleInspectorChange(target);
        // Sync sibling inputs with same data-field (range ↔ number)
        const field = target.dataset.field;
        if (field) {
          const siblings = target.closest('.range-with-input')?.querySelectorAll(`[data-field="${field}"]`);
          if (siblings) siblings.forEach((el) => { if (el !== target) el.value = target.value; });
        }
      }
    };
    document.getElementById('inspectorContent').onclick = (event) => {
      const accordionHead = event.target.closest('[data-accordion]');
      if (accordionHead) {
        const key = accordionHead.dataset.accordion;
        state.inspectorAccordion[key] = !state.inspectorAccordion[key];
        renderInspector();
        return;
      }
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.previewShortform !== undefined) previewShortformCandidate(target.dataset.previewShortform);
      else if (target.id === 'refreshLlmHealthButton') void refreshLlmHealth();
      else if (target.dataset.previewReframe !== undefined) previewReframeKeyframe(Number(target.dataset.previewReframe));
      else if (target.dataset.previewSilence !== undefined) previewSilenceCandidate(Number(target.dataset.previewSilence), Number(target.dataset.previewOccurrence || 0));
      else if (target.id === 'jsonExport') downloadJson();
      else if (target.id === 'addTextKeyframe') addTextKeyframe();
      else if (target.id === 'applyBoxWidthAll') applyBoxWidthToAll();
      else if (target.id === 'importCaptionsButton') document.getElementById('captionInput').click();
      else if (target.id === 'exportCaptionsButton') exportCaptions();
      else if (target.id === 'autoCaptionButton') void startAutoCaption();
      else if (target.id === 'cancelSttButton') void cancelAutoCaption();
      else if (target.id === 'applySttButton') applySttProposal();
      else if (target.id === 'dismissSttButton') dismissSttProposal();
      else if (target.id === 'analyzeShortformButton') void analyzeShortformCandidates();
      else if (target.id === 'cancelShortformButton') cancelShortformAnalysis();
      else if (target.id === 'clearShortformButton') clearShortformCandidates('후보를 다시 생성할 수 있습니다.');
      else if (target.id === 'applyShortformButton') applyShortformCandidate();
      else if (target.id === 'analyzeReframeButton') void analyzeReframe();
      else if (target.id === 'cancelReframeButton') cancelReframeAnalysis();
      else if (target.id === 'applyReframeButton') applyReframeProposal();
      else if (target.id === 'clearReframeButton') clearReframeProposal();
      else if (target.id === 'removeReframeButton') removeAppliedReframe(target.dataset.reframeAsset);
      else if (target.id === 'analyzeSilenceButton') void analyzeSilence();
      else if (target.id === 'applySilenceButton') applySilenceRemoval();
      else if (target.id === 'clearSilenceButton') clearSilenceCandidates();
    };
    const modalRoot = document.getElementById('modalRoot');
    modalRoot.oninput = (event) => {
      const target = event.target;
      if (state.settingsOpen && target.dataset.llmConfig) {
        state.llm.connection = {
          ...state.llm.connection,
          [target.dataset.llmConfig]: String(target.value).slice(0, {
            model: 160,
            apiKey: 2048,
            baseUrl: 500,
          }[target.dataset.llmConfig] || 500),
          dirty: true,
          status: 'idle',
          message: '변경한 값으로 연결 테스트를 실행하세요.',
        };
        return;
      }
      if (!state.settingsOpen || !target.dataset.uiSetting || target.type !== 'range') return;
      updateUiPreferences({ [target.dataset.uiSetting]: Number(target.value) }, { persist: false });
      const value = target.closest('label')?.querySelector('b');
      if (value) value.textContent = `${Math.round(Number(target.value))}px`;
    };
    modalRoot.onchange = (event) => {
      const target = event.target;
      if (state.settingsOpen) {
        if (target.dataset.uiToggle) updateUiPreferences({ [target.dataset.uiToggle]: target.checked });
        else if (target.dataset.uiSetting) updateUiPreferences({ [target.dataset.uiSetting]: target.type === 'range' ? Number(target.value) : target.value });
        else if (target.dataset.settingSemantic !== undefined) updateLlmPreference(target.checked);
        return;
      }
      if (target.name !== 'exportFormat' || state.exportProgress.active) return;
      state.exportFormat = target.value === 'mp4' && state.exportCapability.available ? 'mp4' : 'webm';
      state.exportError = '';
      renderModal();
    };
    modalRoot.onclick = (event) => {
      const llmPreset = event.target.closest('[data-llm-preset]')?.dataset.llmPreset;
      if (llmPreset) {
        state.llm.connection = {
          ...state.llm.connection,
          baseUrl: llmPreset === 'lm-studio'
            ? 'http://host.docker.internal:1234/v1'
            : 'http://host.docker.internal:11434/v1',
          dirty: true,
          status: 'idle',
          message: `${llmPreset === 'lm-studio' ? 'LM Studio' : 'Ollama'} 기본 주소를 적용했습니다. model ID를 확인하세요.`,
        };
        renderModal();
        return;
      }
      const preset = event.target.closest('[data-layout-preset]')?.dataset.layoutPreset;
      if (preset) {
        applyLayoutPreset(preset);
        return;
      }
      if (event.target.id === 'closeSettingsButton' || event.target.id === 'closeSettingsDoneButton') {
        closeSettings();
      } else if (event.target.id === 'resetLayoutButton') {
        updateUiPreferences({
          libraryWidth: defaultUiPreferences.libraryWidth,
          inspectorWidth: defaultUiPreferences.inspectorWidth,
          timelineHeight: defaultUiPreferences.timelineHeight,
          libraryVisible: defaultUiPreferences.libraryVisible,
          inspectorVisible: defaultUiPreferences.inspectorVisible,
          timelineVisible: defaultUiPreferences.timelineVisible,
        }, { render: true });
      } else if (event.target.id === 'copyLlmEnvButton') {
        void copyLlmEnvExample();
      } else if (event.target.id === 'testLlmConnectionButton') {
        void configureLocalLlm(false);
      } else if (event.target.id === 'applyLlmConnectionButton') {
        void configureLocalLlm(true);
      } else if (event.target.id === 'refreshServerStatusButton') {
        void refreshServerStatus();
      } else if (event.target.id === 'closeModal' && !state.exportProgress.active) {
        state.exportOpen = false;
        state.exportError = '';
        renderModal();
      } else if (event.target.id === 'cancelExport') {
        void cancelExport();
      } else if (event.target.id === 'startExport') {
        const quality = document.getElementById('exportQuality').value;
        void startExport(quality);
      }
    };

    document.addEventListener('pointerdown', (event) => {
      if (state.appMenuOpen && !event.target.closest('.app-menu-wrap')) toggleAppMenu(false);
    });
    window.addEventListener('resize', applyUiPreferences);
    window.addEventListener('keydown',(event)=>{
      if (event.key === 'Escape') {
        if (state.appMenuOpen) { toggleAppMenu(false); return; }
        if (state.settingsOpen) { closeSettings(); return; }
      }
      if (state.settingsOpen && event.key === 'Tab') {
        const dialog = document.querySelector('.settings-dialog');
        const focusable = [...(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])];
        if (focusable.length) {
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); return; }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); return; }
        }
      }
      if (event.target.closest('button, [role="menuitem"], [role="menuitemcheckbox"], a')) return;
      if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();redo();}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){event.preventDefault();duplicateSelection();}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();selectAllTimeline();}
      else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteSelection();}
      else if(event.key.toLowerCase()==='s'&&!(event.ctrlKey||event.metaKey)){event.preventDefault();splitSelected();}
      else if(event.code==='Space'){event.preventDefault();togglePlayback();}
      else if(event.key==='ArrowLeft'){event.preventDefault();seek(state.playhead-(event.shiftKey?1:1/30));}
      else if(event.key==='ArrowRight'){event.preventDefault();seek(state.playhead+(event.shiftKey?1:1/30));}
      else if(event.key==='Home'){event.preventDefault();seek(0);}
      else if(event.key==='End'){event.preventDefault();seek(state.project.duration);}
      else if(event.key.toLowerCase()==='j'){event.preventDefault();if(state.playing)stopPlayback();seek(state.playhead-1/30);}
      else if(event.key.toLowerCase()==='k'){event.preventDefault();togglePlayback();}
      else if(event.key.toLowerCase()==='l'){event.preventDefault();if(state.playing)stopPlayback();seek(state.playhead+1/30);}
    });
  }

  function handleInspectorChange(target) {
    const field = target.dataset.field;
    if (!field) return;
    const invalidatesShortform = [
      'clip-timelineStart', 'clip-sourceStart', 'clip-sourceEnd',
      'text-start', 'text-end', 'text-text',
    ].includes(field);
    if (field === 'canvas-ratio') {
      commit((project) => ({ ...project, canvas: { ...project.canvas, ratio: target.value, ...ratios[target.value] } }));
      return;
    }
    const selection = state.selection;
    if (!selection) return;

    state.past.push(clone(state.project));
    if (state.past.length > MAX_HISTORY) state.past.shift();
    state.future = [];
    const project = clone(state.project);
    if (selection.kind === 'clip') {
      const clip = project.clips.find((item) => item.id === selection.id);
      if (!clip) return;
      const key = field.replace('clip-', '');
      clip[key] = Number(target.value);
      clip.timelineStart = Math.max(0, clip.timelineStart);
      clip.sourceStart = Math.max(0, clip.sourceStart);
      clip.sourceEnd = Math.max(clip.sourceStart + .1, clip.sourceEnd);
      clip.volume = clamp(clip.volume, 0, 1);
      clip.speed = clamp(clip.speed || 1, 0.25, 4);
      clip.fadeIn = clamp(clip.fadeIn || 0, 0, 5);
      clip.fadeOut = clamp(clip.fadeOut || 0, 0, 5);
      if (key === 'transition-type') { clip.transition = { ...clip.transition, type: target.value, duration: clip.transition?.duration || 0.5 }; }
      else if (key === 'transition-duration') { clip.transition = { ...clip.transition, type: clip.transition?.type || 'fade', duration: clamp(Number(target.value), 0, 3) }; }
    } else if (selection.kind === 'text') {
      const text = project.texts.find((item) => item.id === selection.id);
      if (!text) return;
      const key = field.replace('text-', '');
      text[key] = key === 'text' || key === 'color' || key === 'fontFamily'
        ? target.value
        : key === 'background'
          ? `${target.value}bb`
          : Number(target.value);
      text.start = Math.max(0, text.start);
      text.end = Math.max(text.start + .1, text.end);
      text.x = clamp(text.x, 0, 100);
      text.y = clamp(text.y, 0, 100);
    }
    state.project = recalculate(project);
    if (invalidatesShortform) invalidateShortformReview('클립 또는 자막이 변경되었습니다. 숏폼 후보를 다시 생성하세요.');
    scheduleSave();
    renderToolbar();
    renderTimeline();
    renderPreviewTexts();
    syncPreview();
    if (invalidatesShortform) renderInspector();
  }

  async function hydrate() {
    try {
      const rawUiPreference = localStorage.getItem(UI_PREFERENCE_KEY);
      state.ui = rawUiPreference ? normalizeUiPreferences(JSON.parse(rawUiPreference)) : { ...defaultUiPreferences };
    } catch {
      state.ui = { ...defaultUiPreferences };
    }
    applyUiPreferences();

    try {
      const rawPreference = localStorage.getItem(LLM_PREFERENCE_KEY);
      if (rawPreference) {
        const preference = JSON.parse(rawPreference);
        if (typeof preference.semanticAssist === 'boolean') state.llm.semanticAssist = preference.semanticAssist;
        else localStorage.removeItem(LLM_PREFERENCE_KEY);
      }
    } catch {
      localStorage.removeItem(LLM_PREFERENCE_KEY);
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const project = JSON.parse(raw);
        project.assets = await Promise.all(project.assets.map(async (asset) => {
          const blob = await loadBlob(asset.id);
          return { ...asset, url: blob ? URL.createObjectURL(blob) : '' };
        }));
        state.project = recalculate(project);
      }
    } catch {
      state.project = emptyProject();
    }

    try {
      const rawDraft = localStorage.getItem(REFRAME_DRAFT_KEY);
      if (rawDraft) {
        const draft = JSON.parse(rawDraft);
        const hasAsset = state.project.assets.some((asset) => asset.id === draft.assetId && asset.kind === 'video');
        const validKeyframes = Array.isArray(draft.keyframes) && draft.keyframes.length
          && draft.keyframes.every((keyframe) => Number.isFinite(keyframe.time) && Number.isFinite(keyframe.x) && Number.isFinite(keyframe.y));
        if (hasAsset && validKeyframes) {
          state.reframe = {
            ...state.reframe,
            analyzing: false,
            status: draft.status === 'applied' ? 'applied' : 'completed',
            progress: 1,
            message: '저장된 자동 리프레임 키프레임을 복원했습니다.',
            assetId: draft.assetId,
            sampleInterval: Number(draft.sampleInterval) || 1,
            method: draft.method || 'visual',
            keyframes: draft.keyframes,
          };
          syncReframeDraftWithProject();
        } else localStorage.removeItem(REFRAME_DRAFT_KEY);
      }
    } catch {
      localStorage.removeItem(REFRAME_DRAFT_KEY);
    }

    state.saveStatus = 'saved';
    renderAll();
    void refreshLlmHealth();
  }

  mountApp(); renderAll(); void hydrate();
})();
