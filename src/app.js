(() => {
  'use strict';

  const STORAGE_KEY = 'shortform-studio:project:v1';
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
    exportProgress: { active: false, progress: 0, status: '' },
    previewVisual: null, previewAudio: null, activeVisualId: '', activeAudioId: '',
    animation: 0, lastFrameAt: 0, saveTimer: 0, draggedClip: '',
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
    state.project = state.past.pop(); scheduleSave(); renderAll();
  }

  function redo() {
    if (!state.future.length) return;
    state.past.push(clone(state.project));
    state.project = state.future.shift(); scheduleSave(); renderAll();
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
            <div id="dropZone" class="drop-zone"><div class="upload-icon">＋</div><strong>미디어 추가</strong><span>파일을 끌어 놓거나 선택하세요</span><button id="pickFiles" class="button subtle" type="button">파일 선택</button></div>
            <p id="mediaError" class="inline-error" hidden></p><div id="assetList" class="asset-list"></div>
          </aside>
          <section class="preview-section">
            <div id="previewStage" class="preview-stage"><div id="canvasFrame" class="canvas-frame"><div id="mediaHost"></div><div id="textLayer"></div><div class="safe-zone"></div></div></div>
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

  function syncPreview(force = false) {
    const frame = document.getElementById('canvasFrame');
    frame.style.aspectRatio = `${state.project.canvas.width} / ${state.project.canvas.height}`;
    frame.style.background = state.project.canvas.background;
    document.getElementById('previewQuality').textContent = `미리보기 · ${state.project.canvas.ratio}`;
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
    else { renderPreviewTexts(); renderPlayback(); }
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
    const numberField = (label, field, value, min = 0, max = '') => `<label class="field"><span>${label}</span><input data-field="${field}" type="number" min="${min}" ${max !== '' ? `max="${max}"` : ''} step="0.1" value="${Number(value).toFixed(2)}"></label>`;
    root.innerHTML = `
      <section class="property-section"><h3>캔버스</h3><label class="field"><span>화면 비율</span><select data-field="canvas-ratio"><option value="9:16" ${state.project.canvas.ratio === '9:16' ? 'selected' : ''}>9:16 · Shorts</option><option value="1:1" ${state.project.canvas.ratio === '1:1' ? 'selected' : ''}>1:1 · Square</option><option value="16:9" ${state.project.canvas.ratio === '16:9' ? 'selected' : ''}>16:9 · Landscape</option></select></label><div class="ratio-meta"><span>${state.project.canvas.width} × ${state.project.canvas.height}</span><em>30 FPS</em></div></section>
      ${clip ? `<section class="property-section"><div class="section-title"><h3>선택한 클립</h3><span class="type-pill">${clip.trackId}</span></div><p class="selected-name">${escapeHtml(asset?.name || '미디어 없음')}</p><div class="field-grid">${numberField('타임라인 시작', 'clip-timelineStart', clip.timelineStart)}${numberField('소스 시작', 'clip-sourceStart', clip.sourceStart, 0, clip.sourceEnd - .1)}${numberField('소스 종료', 'clip-sourceEnd', clip.sourceEnd, clip.sourceStart + .1, asset?.duration || '')}</div><label class="field"><span>볼륨 <b>${Math.round(clip.volume * 100)}%</b></span><input data-field="clip-volume" type="range" min="0" max="1" step="0.01" value="${clip.volume}"></label></section>` : ''}
      ${text ? `<section class="property-section"><div class="section-title"><h3>텍스트</h3><span class="type-pill text">T</span></div><label class="field"><span>내용</span><textarea data-field="text-text" rows="4">${escapeHtml(text.text)}</textarea></label><div class="field-grid">${numberField('시작', 'text-start', text.start)}${numberField('종료', 'text-end', text.end, text.start + .1)}</div><label class="field"><span>글자 크기 <b>${text.fontSize}px</b></span><input data-field="text-fontSize" type="range" min="24" max="120" value="${text.fontSize}"></label><label class="field"><span>굵기</span><select data-field="text-fontWeight">${[400,600,700,800,900].map((weight) => `<option value="${weight}" ${text.fontWeight === weight ? 'selected' : ''}>${weight}</option>`).join('')}</select></label><div class="color-fields"><label><span>글자</span><input data-field="text-color" type="color" value="${text.color}"></label><label><span>배경</span><input data-field="text-background" type="color" value="${text.background.slice(0,7)}"></label></div><div class="field-grid">${numberField('가로 위치 %', 'text-x', text.x, 0, 100)}${numberField('세로 위치 %', 'text-y', text.y, 0, 100)}</div></section>` : ''}
      ${!clip && !text ? '<div class="selection-empty"><div>◇</div><strong>요소를 선택하세요</strong><span>타임라인의 클립이나 텍스트를 선택하면 세부 속성을 편집할 수 있습니다.</span></div>' : ''}
      <section class="property-section ai-section"><div class="ai-title"><span>✦</span><div><h3>AI 도구</h3><small>다음 개발 단계</small></div></div><button disabled>자동 자막 생성 <span>준비 중</span></button><button disabled>침묵 구간 감지 <span>준비 중</span></button><button disabled>세로 자동 리프레임 <span>준비 중</span></button></section><button id="jsonExport" class="button json-button">프로젝트 JSON 다운로드</button>`;
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
    const texts = state.project.texts.map((text) => `<div class="timeline-clip text ${state.selection?.kind === 'text' && state.selection.id === text.id ? 'is-selected' : ''}" data-select-text="${text.id}" style="left:${text.start * state.zoom}px;width:${Math.max(24, (text.end-text.start)*state.zoom)}px"><span class="clip-label"><b>T</b>${escapeHtml(text.text)}</span></div>`).join('');
    document.getElementById('timelineContent').style.width = `${width + LABEL_WIDTH}px`;
    document.getElementById('timelineContent').innerHTML = `<div class="timeline-label-spacer">TIME</div><div class="timeline-ruler" style="margin-left:${LABEL_WIDTH}px;width:${width}px">${ruler}</div><div class="playhead" style="left:${LABEL_WIDTH + state.playhead * state.zoom}px"><i></i><span></span></div><div class="track-row"><div class="track-label"><b>V1</b><span>영상</span></div><div class="track-lane" style="width:${width}px">${clips('video')}</div></div><div class="track-row text-track"><div class="track-label"><b>T1</b><span>텍스트</span></div><div class="track-lane" style="width:${width}px">${texts}</div></div><div class="track-row"><div class="track-label"><b>A1</b><span>오디오</span></div><div class="track-lane" style="width:${width}px">${clips('audio')}</div></div>`;
    document.getElementById('elementCount').textContent = `${state.project.clips.length + state.project.texts.length}개 요소`;
    document.getElementById('zoomInput').value = state.zoom;
  }

  function renderModal() {
    const root = document.getElementById('modalRoot');
    if (!state.exportOpen) { root.innerHTML = ''; return; }
    root.innerHTML = `<div class="modal-backdrop"><section class="export-dialog" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow">EXPORT</span><h2>영상 내보내기</h2></div><button id="closeModal" ${state.exportProgress.active ? 'disabled' : ''}>×</button></div><div class="export-preview"><div style="aspect-ratio:${state.project.canvas.width}/${state.project.canvas.height}">${state.project.canvas.ratio}</div><span>${escapeHtml(state.project.title)}</span></div><label class="field"><span>화질</span><select id="exportQuality" ${state.exportProgress.active ? 'disabled' : ''}><option value="draft">Draft · 540p · 빠른 확인</option><option value="hd">HD · 1080p · 고화질</option></select></label><div class="export-details"><span>WebM</span><span>30 FPS</span><span>${state.project.duration.toFixed(1)}초</span></div><p class="export-note">브라우저에서 실시간 합성하므로 영상 길이만큼 시간이 걸립니다. 상용 MP4는 후속 서버 렌더러에서 제공합니다.</p>${state.exportProgress.active ? `<div class="progress-wrap"><div><span>${state.exportProgress.status}</span><b>${Math.round(state.exportProgress.progress*100)}%</b></div><progress value="${state.exportProgress.progress}" max="1"></progress></div>` : ''}<p id="exportError" class="inline-error" hidden></p><button id="startExport" class="button primary modal-export" ${state.exportProgress.active || !state.project.assets.length ? 'disabled' : ''}>${state.exportProgress.active ? '렌더링 중…' : 'WebM 다운로드'}</button></section></div>`;
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
      project.clips.push({ id: uid(), assetId: id, trackId, timelineStart: start, sourceStart: 0, sourceEnd: Math.max(.1, asset.duration), volume: 1 }); return project;
    });
  }

  async function removeAsset(id) {
    await removeBlob(id).catch(() => undefined);
    commit((project) => ({ ...project, assets: project.assets.filter((asset) => asset.id !== id), clips: project.clips.filter((clip) => clip.assetId !== id) }));
    state.selection = null;
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

  function addText() {
    const id = uid();
    commit((project) => { project.texts.push({ id, text: '텍스트를 입력하세요', start: state.playhead, end: Math.min(project.duration, state.playhead + 4), x: 50, y: 76, fontSize: 56, fontWeight: 800, color: '#ffffff', background: '#00000099', align: 'center' }); return project; });
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

  function drawCover(context, source, sourceWidth, sourceHeight, width, height) {
    const scale = Math.max(width/sourceWidth, height/sourceHeight); const w = sourceWidth*scale, h = sourceHeight*scale;
    context.drawImage(source, (width-w)/2, (height-h)/2, w, h);
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
            if (element.readyState >= 2) drawCover(context, element, element.videoWidth, element.videoHeight, width, height);
            activeId = clip.id;
          } else if (element) drawCover(context, element, element.naturalWidth, element.naturalHeight, width, height);
        }

        const audioClip = state.project.clips.find((item) => item.trackId === 'audio' && time >= item.timelineStart && time < item.timelineStart + item.sourceEnd - item.sourceStart);
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

  function updateExport(progress,status){state.exportProgress={active:true,progress,status};renderModal();}

  function bindEvents() {
    document.getElementById('pickFiles').onclick = () => document.getElementById('fileInput').click();
    document.getElementById('fileInput').onchange = (event) => { void addFiles([...event.target.files]); event.target.value=''; };
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
    document.getElementById('exportButton').onclick=()=>{state.exportOpen=true;renderModal();};

    document.getElementById('assetList').onclick=(event)=>{const add=event.target.closest('[data-add-asset]'),remove=event.target.closest('[data-remove-asset]'),select=event.target.closest('[data-select-asset]');if(add){event.stopPropagation();addAssetToTimeline(add.dataset.addAsset);}else if(remove){event.stopPropagation();void removeAsset(remove.dataset.removeAsset);}else if(select){state.selection={kind:'asset',id:select.dataset.selectAsset};renderAll();}};
    document.getElementById('textLayer').onclick=(event)=>{const target=event.target.closest('[data-select-text]');if(target){state.selection={kind:'text',id:target.dataset.selectText};renderAll();}};
    const timeline=document.getElementById('timelineScroll');
    timeline.onclick=(event)=>{const clip=event.target.closest('[data-select-clip]'),text=event.target.closest('[data-select-text]');if(clip){state.selection={kind:'clip',id:clip.dataset.selectClip};renderAll();return;}if(text){state.selection={kind:'text',id:text.dataset.selectText};renderAll();return;}const rect=timeline.getBoundingClientRect();seek((event.clientX-rect.left+timeline.scrollLeft-LABEL_WIDTH)/state.zoom);};
    timeline.ondragstart=(event)=>{const clip=event.target.closest('[data-select-clip]');if(clip)state.draggedClip=clip.dataset.selectClip;};
    timeline.ondragover=(event)=>event.preventDefault();timeline.ondrop=(event)=>{const target=event.target.closest('[data-select-clip]');if(!target||!state.draggedClip)return;const sourceId=state.draggedClip,targetId=target.dataset.selectClip;commit((project)=>{const source=project.clips.find((c)=>c.id===sourceId),destination=project.clips.find((c)=>c.id===targetId);if(!source||!destination||source.trackId!==destination.trackId)return project;const ordered=project.clips.filter((c)=>c.trackId===source.trackId).sort((a,b)=>a.timelineStart-b.timelineStart);const from=ordered.findIndex((c)=>c.id===sourceId),to=ordered.findIndex((c)=>c.id===targetId);ordered.splice(to,0,ordered.splice(from,1)[0]);let cursor=0;ordered.forEach((c)=>{c.timelineStart=cursor;cursor+=c.sourceEnd-c.sourceStart;});return project;});state.draggedClip='';};
    timeline.onpointerdown=(event)=>{const handle=event.target.closest('[data-trim]');if(!handle)return;event.preventDefault();event.stopPropagation();const clip=state.project.clips.find((item)=>item.id===handle.dataset.clip);if(!clip)return;const startX=event.clientX,startSource=clip.sourceStart,endSource=clip.sourceEnd,startTimeline=clip.timelineStart;window.addEventListener('pointerup',(up)=>{const delta=(up.clientX-startX)/state.zoom;commit((project)=>{const current=project.clips.find((item)=>item.id===clip.id);if(!current)return project;if(handle.dataset.trim==='start'){const bounded=Math.max(-startSource,Math.min(endSource-startSource-.1,delta));current.sourceStart=startSource+bounded;current.timelineStart=startTimeline+bounded;}else current.sourceEnd=Math.max(startSource+.1,endSource+delta);return project;});},{once:true});};

    document.getElementById('inspectorContent').onchange=(event)=>handleInspectorChange(event.target);
    document.getElementById('inspectorContent').oninput=(event)=>{if(event.target.type==='range'||event.target.type==='color')handleInspectorChange(event.target);};
    document.getElementById('inspectorContent').onclick=(event)=>{if(event.target.id==='jsonExport')downloadJson();};
    document.getElementById('modalRoot').onclick=async(event)=>{if(event.target.id==='closeModal'){state.exportOpen=false;renderModal();}if(event.target.id==='startExport'){const quality=document.getElementById('exportQuality').value;state.playing=false;syncPreview();try{const blob=await exportVideo(quality);downloadBlob(blob,`${safeName(state.project.title)}.webm`);state.exportProgress={active:false,progress:1,status:'완료'};state.exportOpen=false;renderModal();}catch(reason){state.exportProgress={active:false,progress:0,status:''};renderModal();const error=document.getElementById('exportError');error.textContent=reason.message||'내보내기에 실패했습니다.';error.hidden=false;}}};

    window.addEventListener('keydown',(event)=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteSelection();}else if(event.key.toLowerCase()==='s'){event.preventDefault();splitSelected();}else if(event.code==='Space'){event.preventDefault();togglePlayback();}});
  }

  function handleInspectorChange(target) {
    const field=target.dataset.field;if(!field)return;
    if(field==='canvas-ratio'){commit((project)=>({...project,canvas:{...project.canvas,ratio:target.value,...ratios[target.value]}}));return;}
    const selection=state.selection;if(!selection)return;
    commit((project)=>{if(selection.kind==='clip'){const clip=project.clips.find((item)=>item.id===selection.id);if(!clip)return project;const key=field.replace('clip-','');clip[key]=Number(target.value);clip.timelineStart=Math.max(0,clip.timelineStart);clip.sourceStart=Math.max(0,clip.sourceStart);clip.sourceEnd=Math.max(clip.sourceStart+.1,clip.sourceEnd);clip.volume=clamp(clip.volume,0,1);}else if(selection.kind==='text'){const text=project.texts.find((item)=>item.id===selection.id);if(!text)return project;const key=field.replace('text-','');text[key]=key==='text'||key==='color'?target.value:key==='background'?`${target.value}bb`:Number(target.value);text.start=Math.max(0,text.start);text.end=Math.max(text.start+.1,text.end);text.x=clamp(text.x,0,100);text.y=clamp(text.y,0,100);}return project;});
  }

  async function hydrate() {
    try {
      const raw=localStorage.getItem(STORAGE_KEY);if(raw){const project=JSON.parse(raw);project.assets=await Promise.all(project.assets.map(async(asset)=>{const blob=await loadBlob(asset.id);return{...asset,url:blob?URL.createObjectURL(blob):''};}));state.project=recalculate(project);}
    } catch { state.project=emptyProject(); }
    state.saveStatus='saved';renderAll();
  }

  mountApp(); renderAll(); void hydrate();
})();
