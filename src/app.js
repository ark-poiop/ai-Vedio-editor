(() => {
  'use strict';

  const STORAGE_KEY = 'shortform-studio:project:v1';
  const REFRAME_DRAFT_KEY = 'shortform-studio:reframe-draft:v1';
  const DB_NAME = 'shortform-studio';
  const DB_STORE = 'media-files';
  const MAX_HISTORY = 50;
  const LABEL_WIDTH = 88;
  const ratios = {
    '9:16': { width: 1080, height: 1920 },
    '1:1': { width: 1080, height: 1080 },
    '16:9': { width: 1920, height: 1080 },
  };

  const uid = () => crypto.randomUUID();
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const clone = (value) => structuredClone(value);
  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const formatTime = (seconds, frames = false) => {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const base = `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
    return frames ? `${base}:${String(Math.floor((safe % 1) * 30)).padStart(2, '0')}` : base;
  };
  const formatSize = (bytes) => bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  const emptyProject = () => ({
    id: uid(), schemaVersion: 1, title: '새 숏폼 프로젝트',
    canvas: { ratio: '9:16', ...ratios['9:16'], background: '#11151d' },
    assets: [], clips: [], texts: [], duration: 30, updatedAt: new Date().toISOString(),
  });

  const state = {
    project: emptyProject(), selection: null, playhead: 0, playing: false, zoom: 18,
    past: [], future: [], saveStatus: 'loading', exportOpen: false,
    exportFormat: 'webm', exportError: '',
    exportCapability: { checked: false, loading: false, available: false, message: '서버 MP4 상태를 확인하지 않았습니다.' },
    exportProgress: { active: false, progress: 0, status: '', jobId: '', format: '' },
    previewVisual: null, previewAudio: null, activeVisualId: '', activeAudioId: '',
    animation: 0, lastFrameAt: 0, saveTimer: 0, draggedClip: '', captionMessage: '',
    sttJob: { active: false, status: 'idle', progress: 0, message: '', id: '', assetId: '', provider: '', demo: false },
    sttProposal: null, sttPollTimer: 0,
    reframe: {
      analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', analysisVersion: 0,
      sampleInterval: 1, method: '', keyframes: [],
    },
    silence: {
      analyzing: false, status: 'idle', progress: 0, message: '', assetId: '', analysisVersion: 0,
      thresholdDb: -40, minimumDuration: 0.6, padding: 0.12, candidates: [],
    },
  };

  function recalculate(project) {
    const clipEnd = project.clips.reduce((max, clip) => Math.max(max, clip.timelineStart + clip.sourceEnd - clip.sourceStart), 0);
    const textEnd = project.texts.reduce((max, text) => Math.max(max, text.end), 0);
    return { ...project, duration: Math.max(15, clipEnd, textEnd), updatedAt: new Date().toISOString() };
  }

  function persistable(project) {
    return { ...project, assets: project.assets.map((asset) => ({
      ...asset, url: '', thumbnail: asset.thumbnail?.startsWith('data:') ? asset.thumbnail : undefined,
    })) };
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
    state.playhead = clamp(state.playhead, 0, state.project.duration);
    scheduleSave();
    renderAll();
  }

  function undo() {
    if (!state.past.length) return;
    state.future.unshift(clone(state.project));
    state.project = state.past.pop();
    syncReframeDraftWithProject();
    scheduleSave(); renderAll();
  }

  function redo() {
    if (!state.future.length) return;
    state.past.push(clone(state.project));
    state.project = state.future.shift();
    syncReframeDraftWithProject();
    scheduleSave(); renderAll();
  }

  function currentClip(track, time = state.playhead) {
    return state.project.clips.find((clip) => clip.trackId === track && time >= clip.timelineStart && time < clip.timelineStart + clip.sourceEnd - clip.sourceStart);
  }

  function mountApp() {
    document.getElementById('root').innerHTML = `
      <main class="app-shell">
        <header class="editor-toolbar">
          <div class="brand-lockup"><div class="brand-mark">S</div><div><strong>Shortform Studio</strong><span>브라우저 편집기 MVP</span></div></div>
          <div class="project-title-wrap"><input id="projectTitle" aria-label="프로젝트 제목"><button id="saveIndicator" class="save-indicator" type="button"><span></span><em>저장됨</em></button></div>
          <div class="toolbar-actions">
            <div class="tool-group"><button id="undoButton" class="icon-button" title="실행 취소">↶</button><button id="redoButton" class="icon-button" title="다시 실행">↷</button></div>
            <div class="tool-group action-labels"><button id="splitButton"><span>✂</span> 분할</button><button id="addTextButton"><span>T</span> 텍스트</button><button id="deleteButton"><span>⌫</span> 삭제</button></div>
            <button id="downloadAppButton" class="button app-download-button" title="이 편집기를 HTML 파일로 저장">앱 파일 저장 <span>↓</span></button>
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
          <section class="preview-section">
            <div id="previewStage" class="preview-stage"><div id="canvasFrame" class="canvas-frame"><div id="mediaHost"></div><div id="reframeBadge" class="reframe-badge" hidden></div><div id="textLayer"></div><div class="safe-zone"></div></div></div>
            <div class="playback-controls"><button id="backButton">−1s</button><button id="playButton" class="play-button">▶</button><button id="forwardButton">+1s</button><span class="timecode"><strong id="currentTime">00:00:00</strong><i>/</i><span id="durationTime">00:30:00</span></span><span id="previewQuality" class="preview-quality">미리보기 · 9:16</span></div>
          </section>
          <aside class="inspector panel"><div class="panel-heading"><div><span class="eyebrow">INSPECTOR</span><h2>속성</h2></div></div><div id="inspectorContent" class="inspector-scroll"></div></aside>
        </div>
        <section class="timeline-section"><div class="timeline-toolbar"><div><strong>타임라인</strong><span id="elementCount">0개 요소</span></div><div class="zoom-control"><span>−</span><input id="zoomInput" type="range" min="8" max="60" value="18" aria-label="타임라인 확대"><span>＋</span></div></div><div id="timelineScroll" class="timeline-scroll"><div id="timelineContent" class="timeline-content"></div></div></section>
        <div id="modalRoot"></div>
      </main>`;
    bindEvents();
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
    document.getElementById('splitButton').disabled = state.selection?.kind !== 'clip';
    document.getElementById('deleteButton').disabled = !state.selection;
    const exportButton = document.getElementById('exportButton');
    exportButton.disabled = hasPendingReframe();
    exportButton.title = hasPendingReframe() ? '자동 리프레임 제안을 적용하거나 취소한 뒤 내보낼 수 있습니다.' : '';
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
      const sourceTime = clip.sourceStart + state.playhead - clip.timelineStart;
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
        video.volume = clip.volume; video.currentTime = Math.max(0, clip.sourceStart + state.playhead - clip.timelineStart);
        host.append(video); state.previewVisual = video;
        if (state.playing) void video.play().catch(() => { state.playing = false; renderPlayback(); });
      }
    } else if (clip && state.previewVisual instanceof HTMLVideoElement && !state.playing) {
      const expected = clip.sourceStart + state.playhead - clip.timelineStart;
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
      .map((text) => `<div class="preview-text" data-select-text="${text.id}" style="left:${text.x}%;top:${text.y}%;color:${text.color};background:${text.background};font-size:${Math.max(12, text.fontSize / 3.2)}px;font-weight:${text.fontWeight};text-align:${text.align}">${escapeHtml(text.text).replaceAll('\n', '<br>')}</div>`).join('');
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
    state.lastFrameAt = timestamp;
    state.playhead = Math.min(state.project.duration, state.playhead + delta);
    if (currentClip('video')?.id !== previousVisualId || currentClip('audio')?.id !== previousAudioId) syncPreview(true);
    else { updatePreviewReframe(); renderPreviewTexts(); renderPlayback(); }
    if (state.playhead >= state.project.duration) { state.playing = false; state.previewVisual?.pause?.(); state.previewAudio?.pause?.(); renderPlayback(); return; }
    state.animation = requestAnimationFrame(animate);
  }

  function seek(time) {
    state.playhead = clamp(time, 0, state.project.duration);
    syncPreview(true); renderPlayback();
  }

  function renderInspector() {
    const root = document.getElementById('inspectorContent');
    const clip = state.selection?.kind === 'clip' ? state.project.clips.find((item) => item.id === state.selection.id) : null;
    const asset = clip && state.project.assets.find((item) => item.id === clip.assetId);
    const text = state.selection?.kind === 'text' ? state.project.texts.find((item) => item.id === state.selection.id) : null;
    const sttAsset = getTranscribableAsset();
    const sttProposal = state.sttProposal;
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
    root.innerHTML = `
      <section class="property-section"><h3>캔버스</h3><label class="field"><span>화면 비율</span><select data-field="canvas-ratio"><option value="9:16" ${state.project.canvas.ratio === '9:16' ? 'selected' : ''}>9:16 · Shorts</option><option value="1:1" ${state.project.canvas.ratio === '1:1' ? 'selected' : ''}>1:1 · Square</option><option value="16:9" ${state.project.canvas.ratio === '16:9' ? 'selected' : ''}>16:9 · Landscape</option></select></label><div class="ratio-meta"><span>${state.project.canvas.width} × ${state.project.canvas.height}</span><em>30 FPS</em></div></section>
      ${clip ? `<section class="property-section"><div class="section-title"><h3>선택한 클립</h3><span class="type-pill">${clip.trackId}</span></div><p class="selected-name">${escapeHtml(asset?.name || '미디어 없음')}</p><div class="field-grid">${numberField('타임라인 시작', 'clip-timelineStart', clip.timelineStart)}${numberField('소스 시작', 'clip-sourceStart', clip.sourceStart, 0, clip.sourceEnd - .1)}${numberField('소스 종료', 'clip-sourceEnd', clip.sourceEnd, clip.sourceStart + .1, asset?.duration || '')}</div><label class="field"><span>볼륨 <b>${Math.round(clip.volume * 100)}%</b></span><input data-field="clip-volume" type="range" min="0" max="1" step="0.01" value="${clip.volume}"></label></section>` : ''}
      ${text ? `<section class="property-section"><div class="section-title"><h3>${text.role === 'caption' ? '자막' : '텍스트'}</h3><span class="type-pill text">${text.role === 'caption' ? 'CC' : 'T'}</span></div><label class="field"><span>내용</span><textarea data-field="text-text" rows="4">${escapeHtml(text.text)}</textarea></label><div class="field-grid">${numberField('시작', 'text-start', text.start)}${numberField('종료', 'text-end', text.end, text.start + .1)}</div><label class="field"><span>글자 크기 <b>${text.fontSize}px</b></span><input data-field="text-fontSize" type="range" min="24" max="120" value="${text.fontSize}"></label><label class="field"><span>굵기</span><select data-field="text-fontWeight">${[400,600,700,800,900].map((weight) => `<option value="${weight}" ${text.fontWeight === weight ? 'selected' : ''}>${weight}</option>`).join('')}</select></label><div class="color-fields"><label><span>글자</span><input data-field="text-color" type="color" value="${text.color}"></label><label><span>배경</span><input data-field="text-background" type="color" value="${text.background.slice(0,7)}"></label></div><div class="field-grid">${numberField('가로 위치 %', 'text-x', text.x, 0, 100)}${numberField('세로 위치 %', 'text-y', text.y, 0, 100)}</div></section>` : ''}
      ${!clip && !text ? '<div class="selection-empty"><div>◇</div><strong>요소를 선택하세요</strong><span>타임라인의 클립이나 텍스트를 선택하면 세부 속성을 편집할 수 있습니다.</span></div>' : ''}
      <section class="property-section caption-section"><div class="ai-title"><span>CC</span><div><h3>자막 도구</h3><small>SRT · WebVTT</small></div></div><button id="importCaptionsButton">자막 파일 가져오기 <span>SRT/VTT</span></button><button id="exportCaptionsButton" ${state.project.texts.some((item) => item.role === 'caption') ? '' : 'disabled'}>자막 SRT 저장 <span>${state.project.texts.filter((item) => item.role === 'caption').length}개</span></button>${state.captionMessage ? `<p class="caption-message">${escapeHtml(state.captionMessage)}</p>` : ''}</section>
      <section class="property-section ai-section"><div class="ai-title"><span>✦</span><div><h3>AI 자동 자막</h3><small>${sttAsset ? escapeHtml(sttAsset.name) : '영상 또는 오디오 필요'}</small></div></div><button id="autoCaptionButton" ${!sttAsset || state.sttJob.active || sttProposal || sttRequiresServer ? 'disabled' : ''}>자동 자막 생성 <span>${sttStatusLabel}</span></button>${sttRequiresServer ? '<p class="ai-notice">자동 자막 API는 <code>npm run dev</code> 실행 시 사용할 수 있습니다. 단일 HTML에서는 SRT/VTT 가져오기를 이용하세요.</p>' : ''}${state.sttJob.active ? `<div class="stt-status"><div><span>${escapeHtml(state.sttJob.message)}</span><b>${Math.round(state.sttJob.progress * 100)}%</b></div><progress value="${state.sttJob.progress}" max="1"></progress><button id="cancelSttButton" class="danger-action">작업 취소</button></div>` : state.sttJob.message ? `<p class="stt-message ${state.sttJob.status === 'failed' ? 'error' : ''}">${escapeHtml(state.sttJob.message)}</p>` : ''}${sttProposal ? `<div class="stt-proposal"><div class="proposal-head"><strong>자막 제안 ${sttProposal.segments.length}개</strong><span>${escapeHtml(sttProposal.provider)}${sttProposal.demo ? ' · DEMO' : ''}</span></div><div class="proposal-list">${sttProposal.segments.slice(0, 4).map((segment) => `<div><time>${formatTime(segment.start)}–${formatTime(segment.end)}</time><p>${escapeHtml(segment.text)}</p>${Number.isFinite(segment.confidence) ? `<em>${Math.round(segment.confidence * 100)}%</em>` : ''}</div>`).join('')}</div><div class="proposal-actions"><button id="dismissSttButton">취소</button><button id="applySttButton" class="apply">타임라인에 적용</button></div></div>` : ''}</section>
      <section class="property-section reframe-section"><div class="ai-title"><span>▣</span><div><h3>세로 자동 리프레임</h3><small>${reframeAsset ? `${reframeHasBoundAsset ? '분석 대상 · ' : ''}${escapeHtml(reframeAsset.name)}` : reframeHasBoundAsset ? '분석 대상이 삭제됨' : '가로 영상 필요'}</small></div></div><label class="field"><span>프레임 샘플 간격</span><select data-reframe-setting="sampleInterval" ${reframe.analyzing ? 'disabled' : ''}><option value="0.5" ${reframe.sampleInterval === 0.5 ? 'selected' : ''}>0.5초 · 정밀</option><option value="1" ${reframe.sampleInterval === 1 ? 'selected' : ''}>1초 · 균형</option><option value="2" ${reframe.sampleInterval === 2 ? 'selected' : ''}>2초 · 빠름</option></select></label><button id="analyzeReframeButton" ${!reframeAsset || reframe.analyzing || reframe.keyframes.length ? 'disabled' : ''}>${reframe.analyzing ? '피사체 추적 중…' : reframe.keyframes.length ? '키프레임 검토 중' : '세로 구도 분석'} <span>9:16</span></button>${appliedReframeCount && !reframe.keyframes.length ? `<button id="removeReframeButton" class="reframe-remove" data-reframe-asset="${reframeAsset.id}">적용된 리프레임 해제 <span>${appliedReframeCount}개</span></button>` : ''}${reframe.analyzing ? `<div class="reframe-status"><div><span>${escapeHtml(reframe.message)}</span><b>${Math.round(reframe.progress * 100)}%</b></div><progress value="${reframe.progress}" max="1"></progress><button id="cancelReframeButton" class="danger-action">분석 취소</button></div>` : reframe.message ? `<p class="reframe-message ${reframe.status === 'failed' ? 'error' : ''}">${escapeHtml(reframe.message)}</p>` : ''}${reframe.keyframes.length ? `<div class="reframe-review"><div class="reframe-review-head"><strong>포커스 키프레임 ${reframe.keyframes.length}개</strong><span>${reframeMethodLabel}</span></div><p class="reframe-help">시간을 눌러 구도를 확인하고 가로 위치를 직접 보정할 수 있습니다.</p><div class="reframe-keyframes">${reframe.keyframes.map((keyframe, index) => `<div class="reframe-keyframe"><button type="button" data-preview-reframe="${index}">${formatTime(keyframe.time, true)}</button><label><span>가로 ${Math.round(keyframe.x * 100)}%</span><input type="range" min="0" max="100" step="1" value="${Math.round(keyframe.x * 100)}" data-reframe-keyframe="${index}" data-reframe-axis="x"></label><em>${Math.round(keyframe.confidence * 100)}%</em></div>`).join('')}</div><div class="proposal-actions"><button id="clearReframeButton">취소</button><button id="applyReframeButton" class="apply">9:16에 적용</button></div></div>` : ''}</section>
      <section class="property-section silence-section"><div class="ai-title"><span>∿</span><div><h3>침묵 구간 감지</h3><small>${silenceAsset ? `${silenceHasBoundAsset ? '분석 대상 · ' : ''}${escapeHtml(silenceAsset.name)}` : silenceHasBoundAsset ? '분석 대상이 삭제됨' : '영상 또는 오디오 필요'}</small></div></div><div class="field-grid silence-settings"><label class="field"><span>임계값 dB</span><input data-silence-field="thresholdDb" type="number" min="-80" max="-5" step="1" value="${silence.thresholdDb}" ${silence.analyzing ? 'disabled' : ''}></label><label class="field"><span>최소 길이 초</span><input data-silence-field="minimumDuration" type="number" min="0.1" max="10" step="0.1" value="${silence.minimumDuration}" ${silence.analyzing ? 'disabled' : ''}></label></div><label class="field"><span>음성 여백 초 <b>${silence.padding.toFixed(2)}</b></span><input data-silence-field="padding" type="range" min="0" max="1" step="0.01" value="${silence.padding}" ${silence.analyzing ? 'disabled' : ''}></label><button id="analyzeSilenceButton" class="silence-analyze" ${!sttAsset || silence.analyzing || silence.candidates.length ? 'disabled' : ''}>${silence.analyzing ? '오디오 분석 중…' : silence.candidates.length ? '후보 검토 중' : '침묵 구간 분석'} <span>${silence.thresholdDb} dB</span></button>${silence.analyzing ? `<div class="silence-status"><div><span>${escapeHtml(silence.message)}</span><b>${Math.round(silence.progress * 100)}%</b></div><progress value="${silence.progress}" max="1"></progress></div>` : silence.message ? `<p class="silence-message ${silence.status === 'failed' ? 'error' : ''}">${escapeHtml(silence.message)}</p>` : ''}${silence.candidates.length ? `<div class="silence-review"><div class="silence-review-head"><strong>삭제 후보 ${silence.candidates.length}개</strong><span>${selectedSilences.length}개 선택</span></div><div class="silence-list">${silence.candidates.map((candidate, index) => { const occurrences = candidateTimelineRemovals[index]; const occurrenceDuration = occurrences.reduce((total, range) => total + range.end - range.start, 0); return `<div class="silence-candidate"><label><input type="checkbox" data-silence-candidate="${index}" ${candidate.selected ? 'checked' : ''} ${occurrences.length ? '' : 'disabled'}><span><strong>${formatTime(candidate.start, true)}–${formatTime(candidate.end, true)}</strong><small>${occurrences.length ? `타임라인 ${occurrences.length}곳 · 실제 ${occurrenceDuration.toFixed(2)}초` : '현재 타임라인에 적용 구간 없음'}</small></span></label><div class="silence-occurrences">${occurrences.map((range, occurrenceIndex) => `<button type="button" data-preview-silence="${index}" data-preview-occurrence="${occurrenceIndex}" title="${formatTime(range.start, true)}–${formatTime(range.end, true)}로 이동">${occurrenceIndex + 1}</button>`).join('')}</div></div>`; }).join('')}</div><div class="silence-total"><span>타임라인 ${selectedTimelineRemovals.length}개 구간</span><strong>${selectedSilenceDuration.toFixed(2)}초</strong></div><div class="proposal-actions"><button id="clearSilenceButton">취소</button><button id="applySilenceButton" class="apply" ${selectedTimelineRemovals.length && silenceAsset ? '' : 'disabled'}>리플 삭제 적용</button></div></div>` : ''}</section><button id="jsonExport" class="button json-button">프로젝트 JSON 다운로드</button>`;
  }

  function renderTimeline() {
    const width = Math.max(900, state.project.duration * state.zoom + 80);
    const interval = state.zoom < 12 ? 5 : state.zoom < 24 ? 2 : 1;
    const ruler = Array.from({ length: Math.ceil(state.project.duration) + 1 }, (_, i) => i)
      .filter((i) => i % interval === 0).map((i) => `<span style="left:${i * state.zoom}px">${formatTime(i)}</span>`).join('');
    const clips = (track) => state.project.clips.filter((clip) => clip.trackId === track).map((clip) => {
      const asset = state.project.assets.find((item) => item.id === clip.assetId);
      const duration = clip.sourceEnd - clip.sourceStart;
      return `<div class="timeline-clip ${track} ${state.selection?.kind === 'clip' && state.selection.id === clip.id ? 'is-selected' : ''}" data-select-clip="${clip.id}" draggable="true" style="left:${clip.timelineStart * state.zoom}px;width:${Math.max(18, duration * state.zoom)}px"><button class="trim-handle left" data-trim="start" data-clip="${clip.id}"></button>${asset?.thumbnail && track === 'video' ? `<span class="clip-thumb" style="background-image:url('${asset.thumbnail}')"></span>` : ''}<span class="clip-label"><b>${track === 'audio' ? '♪' : '▶'}</b>${escapeHtml(asset?.name || '미디어 없음')}</span><span class="clip-duration">${duration.toFixed(1)}s</span><button class="trim-handle right" data-trim="end" data-clip="${clip.id}"></button></div>`;
    }).join('');
    const texts = state.project.texts.map((text) => `<div class="timeline-clip text ${text.role === 'caption' ? 'caption' : ''} ${state.selection?.kind === 'text' && state.selection.id === text.id ? 'is-selected' : ''}" data-select-text="${text.id}" style="left:${text.start * state.zoom}px;width:${Math.max(24, (text.end-text.start)*state.zoom)}px"><span class="clip-label"><b>${text.role === 'caption' ? 'CC' : 'T'}</b>${escapeHtml(text.text)}</span></div>`).join('');
    document.getElementById('timelineContent').style.width = `${width + LABEL_WIDTH}px`;
    document.getElementById('timelineContent').innerHTML = `<div class="timeline-label-spacer">TIME</div><div class="timeline-ruler" style="margin-left:${LABEL_WIDTH}px;width:${width}px">${ruler}</div><div class="playhead" style="left:${LABEL_WIDTH + state.playhead * state.zoom}px"><i></i><span></span></div><div class="track-row"><div class="track-label"><b>V1</b><span>영상</span></div><div class="track-lane" style="width:${width}px">${clips('video')}</div></div><div class="track-row text-track"><div class="track-label"><b>T1</b><span>텍스트·자막</span></div><div class="track-lane" style="width:${width}px">${texts}</div></div><div class="track-row"><div class="track-label"><b>A1</b><span>오디오</span></div><div class="track-lane" style="width:${width}px">${clips('audio')}</div></div>`;
    document.getElementById('elementCount').textContent = `${state.project.clips.length + state.project.texts.length}개 요소`;
    document.getElementById('zoomInput').value = state.zoom;
  }

  function renderModal() {
    const root = document.getElementById('modalRoot');
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
    root.innerHTML = `<div class="modal-backdrop"><section class="export-dialog" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow">EXPORT</span><h2>영상 내보내기</h2></div><button id="closeModal" ${progress.active ? 'disabled' : ''}>×</button></div><div class="export-preview"><div style="aspect-ratio:${state.project.canvas.width}/${state.project.canvas.height}">${state.project.canvas.ratio}</div><span>${escapeHtml(state.project.title)}</span></div><div class="export-format-grid"><label class="export-format ${isMp4 ? 'selected' : ''} ${capability.available ? '' : 'disabled'}"><input type="radio" name="exportFormat" value="mp4" ${isMp4 ? 'checked' : ''} ${progress.active || !capability.available ? 'disabled' : ''}><strong>MP4</strong><small>${escapeHtml(mp4Reason)}</small></label><label class="export-format ${!isMp4 ? 'selected' : ''}"><input type="radio" name="exportFormat" value="webm" ${!isMp4 ? 'checked' : ''} ${progress.active ? 'disabled' : ''}><strong>WebM</strong><small>브라우저 실시간 렌더 · 서버 불필요</small></label></div><label class="field"><span>화질</span><select id="exportQuality" ${progress.active ? 'disabled' : ''}><option value="draft">Draft · 540p · 빠른 확인</option><option value="hd">HD · 1080p · 고화질</option></select></label><div class="export-details"><span>${isMp4 ? 'H.264 MP4' : 'WebM'}</span><span>30 FPS</span><span>${state.project.duration.toFixed(1)}초</span></div><p class="export-note">${isMp4 ? '원본을 서버에 업로드한 뒤 비동기 FFmpeg Job으로 영상·오디오·자막·리프레임을 합성합니다.' : '브라우저에서 실시간 합성하므로 영상 길이만큼 시간이 걸립니다.'}</p>${progress.active ? `<div class="progress-wrap"><div><span>${escapeHtml(progress.status)}</span><b>${Math.round(progress.progress * 100)}%</b></div><progress value="${progress.progress}" max="1"></progress></div>` : ''}<p id="exportError" class="inline-error" ${state.exportError ? '' : 'hidden'}>${escapeHtml(state.exportError)}</p><div class="export-actions">${progress.active && progress.format === 'mp4' ? '<button id="cancelExport" class="button export-cancel">내보내기 취소</button>' : ''}<button id="startExport" class="button primary modal-export" ${progress.active || !state.project.assets.length ? 'disabled' : ''}>${progress.active ? (progress.format === 'mp4' ? 'MP4 렌더링 중…' : 'WebM 렌더링 중…') : `${isMp4 ? 'MP4' : 'WebM'} 다운로드`}</button></div></section></div>`;
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
    if (!state.selection) return;
    if (state.selection.kind === 'asset') { void removeAsset(state.selection.id); return; }
    const selection = state.selection;
    commit((project) => ({ ...project, clips: selection.kind === 'clip' ? project.clips.filter((clip) => clip.id !== selection.id) : project.clips, texts: selection.kind === 'text' ? project.texts.filter((text) => text.id !== selection.id) : project.texts }));
    state.selection = null;
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
          'X-Language': 'ko',
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
        message: job.status === 'queued' ? '작업 대기 중' : '음성을 분석하고 있습니다.',
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
    state.sttProposal = null;
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
      const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
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
    commit((project) => { project.texts.push({ id, role: 'text', text: '텍스트를 입력하세요', start: state.playhead, end: Math.min(project.duration, state.playhead + 4), x: 50, y: 76, fontSize: 56, fontWeight: 800, color: '#ffffff', background: '#00000099', align: 'center' }); return project; });
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
        const blob = await exportVideo(quality);
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
    if (!state.exportProgress.active || state.exportProgress.format !== 'mp4') return;
    const jobId = state.exportProgress.jobId;
    exportRunVersion += 1;
    exportController?.abort();
    exportController = null;
    state.exportProgress = { active: false, progress: 0, status: '취소됨', jobId: '', format: '' };
    state.exportError = 'MP4 내보내기를 취소했습니다.';
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

  function drawText(context, text, scale, width, height) {
    const x = width*text.x/100, y = height*text.y/100, size = Math.round(text.fontSize*scale);
    context.font = `${text.fontWeight} ${size}px sans-serif`; context.textAlign = text.align; context.textBaseline = 'middle';
    const metrics = context.measureText(text.text); const padding = size*.22;
    let left = x-metrics.width/2; if (text.align === 'left') left=x; if (text.align === 'right') left=x-metrics.width;
    context.fillStyle=text.background; context.fillRect(left-padding,y-size*.7,metrics.width+padding*2,size*1.4); context.fillStyle=text.color; context.fillText(text.text,x,y);
  }

  async function exportVideo(quality) {
    if (!window.MediaRecorder) throw new Error('이 브라우저는 영상 내보내기를 지원하지 않습니다.');
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

    await new Promise((resolve) => {
      const frame = () => {
        const time = Math.min(state.project.duration, (performance.now() - started) / 1000);
        context.fillStyle = state.project.canvas.background;
        context.fillRect(0, 0, width, height);
        const clip = state.project.clips.find((item) => item.trackId === 'video' && time >= item.timelineStart && time < item.timelineStart + item.sourceEnd - item.sourceStart);
        for (const [id, element] of elements) {
          if (element instanceof HTMLVideoElement && id !== clip?.assetId) element.pause();
        }
        if (clip) {
          const element = elements.get(clip.assetId);
          if (element instanceof HTMLVideoElement) {
            const expected = clip.sourceStart + time - clip.timelineStart;
            if (activeId !== clip.id || Math.abs(element.currentTime - expected) > .35) element.currentTime = expected;
            element.volume = clip.volume;
            if (element.paused) void element.play();
            if (element.readyState >= 2) {
              const focus = clip.reframe?.enabled ? focusAtSourceTime(clip.reframe, expected) : { x: 0.5, y: 0.5 };
              drawCover(context, element, element.videoWidth, element.videoHeight, width, height, focus);
            }
            activeId = clip.id;
          } else if (element) drawCover(context, element, element.naturalWidth, element.naturalHeight, width, height);
        }

        const audioClip = state.project.clips.find((item) => item.trackId === 'audio' && time >= item.timelineStart && time < item.timelineStart + item.sourceEnd - item.sourceStart);
        const activeVideoElement = clip && elements.get(clip.assetId);
        if (activeVideoElement instanceof HTMLVideoElement) activeVideoElement.muted = Boolean(audioClip);
        for (const [id, element] of audioElements) {
          if (id !== audioClip?.assetId) element.pause();
        }
        if (audioClip) {
          const element = audioElements.get(audioClip.assetId);
          if (element) {
            const expected = audioClip.sourceStart + time - audioClip.timelineStart;
            if (activeAudioId !== audioClip.id || Math.abs(element.currentTime - expected) > .35) element.currentTime = expected;
            element.volume = audioClip.volume;
            if (element.paused) void element.play();
            activeAudioId = audioClip.id;
          }
        }

        state.project.texts.filter((text) => time >= text.start && time <= text.end)
          .forEach((text) => drawText(context, text, width / state.project.canvas.width, width, height));
        updateExport(time / state.project.duration, `렌더링 ${Math.round(time / state.project.duration * 100)}%`);
        if (time >= state.project.duration) resolve(); else requestAnimationFrame(frame);
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
    document.getElementById('splitButton').onclick=splitSelected; document.getElementById('addTextButton').onclick=addText; document.getElementById('deleteButton').onclick=deleteSelection;
    document.getElementById('backButton').onclick=()=>seek(state.playhead-1);document.getElementById('forwardButton').onclick=()=>seek(state.playhead+1);document.getElementById('playButton').onclick=togglePlayback;
    document.getElementById('zoomInput').oninput=(event)=>{state.zoom=Number(event.target.value);renderTimeline();};
    document.getElementById('downloadAppButton').onclick=downloadStandaloneApp;
    document.getElementById('exportButton').onclick=()=>{if(hasPendingReframe())return;state.exportOpen=true;state.exportError='';renderModal();void refreshRenderCapability();};

    document.getElementById('assetList').onclick=(event)=>{const add=event.target.closest('[data-add-asset]'),remove=event.target.closest('[data-remove-asset]'),select=event.target.closest('[data-select-asset]');if(add){event.stopPropagation();addAssetToTimeline(add.dataset.addAsset);}else if(remove){event.stopPropagation();void removeAsset(remove.dataset.removeAsset);}else if(select){state.selection={kind:'asset',id:select.dataset.selectAsset};renderAll();}};
    document.getElementById('textLayer').onclick=(event)=>{const target=event.target.closest('[data-select-text]');if(target){state.selection={kind:'text',id:target.dataset.selectText};renderAll();}};
    const timeline=document.getElementById('timelineScroll');
    timeline.onclick=(event)=>{const clip=event.target.closest('[data-select-clip]'),text=event.target.closest('[data-select-text]');if(clip){state.selection={kind:'clip',id:clip.dataset.selectClip};renderAll();return;}if(text){state.selection={kind:'text',id:text.dataset.selectText};renderAll();return;}const rect=timeline.getBoundingClientRect();seek((event.clientX-rect.left+timeline.scrollLeft-LABEL_WIDTH)/state.zoom);};
    timeline.ondragstart=(event)=>{const clip=event.target.closest('[data-select-clip]');if(clip)state.draggedClip=clip.dataset.selectClip;};
    timeline.ondragover=(event)=>event.preventDefault();timeline.ondrop=(event)=>{const target=event.target.closest('[data-select-clip]');if(!target||!state.draggedClip)return;const sourceId=state.draggedClip,targetId=target.dataset.selectClip;commit((project)=>{const source=project.clips.find((c)=>c.id===sourceId),destination=project.clips.find((c)=>c.id===targetId);if(!source||!destination||source.trackId!==destination.trackId)return project;const ordered=project.clips.filter((c)=>c.trackId===source.trackId).sort((a,b)=>a.timelineStart-b.timelineStart);const from=ordered.findIndex((c)=>c.id===sourceId),to=ordered.findIndex((c)=>c.id===targetId);ordered.splice(to,0,ordered.splice(from,1)[0]);let cursor=0;ordered.forEach((c)=>{c.timelineStart=cursor;cursor+=c.sourceEnd-c.sourceStart;});return project;});state.draggedClip='';};
    timeline.onpointerdown=(event)=>{const handle=event.target.closest('[data-trim]');if(!handle)return;event.preventDefault();event.stopPropagation();const clip=state.project.clips.find((item)=>item.id===handle.dataset.clip);if(!clip)return;const startX=event.clientX,startSource=clip.sourceStart,endSource=clip.sourceEnd,startTimeline=clip.timelineStart;window.addEventListener('pointerup',(up)=>{const delta=(up.clientX-startX)/state.zoom;commit((project)=>{const current=project.clips.find((item)=>item.id===clip.id);if(!current)return project;if(handle.dataset.trim==='start'){const bounded=Math.max(-startSource,Math.min(endSource-startSource-.1,delta));current.sourceStart=startSource+bounded;current.timelineStart=startTimeline+bounded;}else current.sourceEnd=Math.max(startSource+.1,endSource+delta);return project;});},{once:true});};

    document.getElementById('inspectorContent').onchange=(event)=>{
      const target = event.target;
      if (target.dataset.reframeSetting) updateReframeSetting(target.value);
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
      } else if(target.type==='range'||target.type==='color') handleInspectorChange(target);
    };
    document.getElementById('inspectorContent').onclick=(event)=>{const target=event.target.closest('button');if(!target)return;if(target.dataset.previewReframe !== undefined)previewReframeKeyframe(Number(target.dataset.previewReframe));else if(target.dataset.previewSilence !== undefined)previewSilenceCandidate(Number(target.dataset.previewSilence), Number(target.dataset.previewOccurrence || 0));else if(target.id==='jsonExport')downloadJson();else if(target.id==='importCaptionsButton')document.getElementById('captionInput').click();else if(target.id==='exportCaptionsButton')exportCaptions();else if(target.id==='autoCaptionButton')void startAutoCaption();else if(target.id==='cancelSttButton')void cancelAutoCaption();else if(target.id==='applySttButton')applySttProposal();else if(target.id==='dismissSttButton')dismissSttProposal();else if(target.id==='analyzeReframeButton')void analyzeReframe();else if(target.id==='cancelReframeButton')cancelReframeAnalysis();else if(target.id==='applyReframeButton')applyReframeProposal();else if(target.id==='clearReframeButton')clearReframeProposal();else if(target.id==='removeReframeButton')removeAppliedReframe(target.dataset.reframeAsset);else if(target.id==='analyzeSilenceButton')void analyzeSilence();else if(target.id==='applySilenceButton')applySilenceRemoval();else if(target.id==='clearSilenceButton')clearSilenceCandidates();};
    const modalRoot = document.getElementById('modalRoot');
    modalRoot.onchange = (event) => {
      if (event.target.name !== 'exportFormat' || state.exportProgress.active) return;
      state.exportFormat = event.target.value === 'mp4' && state.exportCapability.available ? 'mp4' : 'webm';
      state.exportError = '';
      renderModal();
    };
    modalRoot.onclick = (event) => {
      if (event.target.id === 'closeModal' && !state.exportProgress.active) {
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

    window.addEventListener('keydown',(event)=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteSelection();}else if(event.key.toLowerCase()==='s'){event.preventDefault();splitSelected();}else if(event.code==='Space'){event.preventDefault();togglePlayback();}});
  }

  function handleInspectorChange(target) {
    const field = target.dataset.field;
    if (!field) return;
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
    } else if (selection.kind === 'text') {
      const text = project.texts.find((item) => item.id === selection.id);
      if (!text) return;
      const key = field.replace('text-', '');
      text[key] = key === 'text' || key === 'color'
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
    scheduleSave();
    renderToolbar();
    renderTimeline();
    syncPreview();
  }

  async function hydrate() {
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
  }

  mountApp(); renderAll(); void hydrate();
})();
