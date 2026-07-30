import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_PROJECT_BYTES = 5 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ASSET_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_EXTENSIONS = new Map([
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'],
  ['audio/mpeg', '.mp3'], ['audio/mp4', '.m4a'], ['audio/wav', '.wav'], ['audio/ogg', '.ogg'],
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function boundedNumber(value, minimum, maximum, fallback = minimum) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.min(maximum, Math.max(minimum, numericValue)) : fallback;
}

function even(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function safeName(value, fallback = 'shortform') {
  return String(value || fallback).replace(/[^a-zA-Z0-9가-힣._-]/g, '-').slice(0, 120) || fallback;
}

function publicAsset(asset) {
  return {
    id: asset.id,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    size: asset.size,
    uploadedAt: asset.uploadedAt,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    quality: job.quality,
    format: 'mp4',
    width: job.width,
    height: job.height,
    duration: job.duration,
    assetCount: job.assetCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.status === 'completed' ? {
      url: `/api/render/jobs/${job.id}/result`,
      fileName: job.fileName,
      size: job.outputSize,
      mimeType: 'video/mp4',
    } : null,
    error: job.error,
  };
}

async function readRequestBody(request, maximumBytes, allowEmpty = false) {
  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength > maximumBytes) throw Object.assign(new Error('요청 데이터가 허용 크기를 초과했습니다.'), { statusCode: 413 });
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maximumBytes) throw Object.assign(new Error('요청 데이터가 허용 크기를 초과했습니다.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!allowEmpty && !received) throw Object.assign(new Error('요청 데이터가 비어 있습니다.'), { statusCode: 400 });
  return Buffer.concat(chunks);
}

async function writeUpload(request, target, maximumBytes) {
  const contentLength = Number(request.headers['content-length'] || 0);
  if (contentLength > maximumBytes) throw Object.assign(new Error('렌더 자산이 허용 크기를 초과했습니다.'), { statusCode: 413 });
  let received = 0;
  const limiter = async function* () {
    for await (const chunk of request) {
      received += chunk.length;
      if (received > maximumBytes) throw Object.assign(new Error('렌더 자산이 허용 크기를 초과했습니다.'), { statusCode: 413 });
      yield chunk;
    }
  };
  try {
    await pipeline(limiter(), createWriteStream(target, { flags: 'wx' }));
    if (!received) throw Object.assign(new Error('렌더 자산이 비어 있습니다.'), { statusCode: 400 });
    return received;
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

function runProcess(command, args, { signal, onStdout, onStderr, onChild } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child;
    let killTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500);
      killTimer.unref?.();
    };
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    onChild?.(child);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      stdout += value;
      if (stdout.length > 128_000) stdout = stdout.slice(-128_000);
      onStdout?.(value);
    });
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString();
      stderr += value;
      if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
      onStderr?.(value);
    });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code, terminationSignal) => {
      if (signal?.aborted) {
        const error = new Error('렌더링이 취소되었습니다.');
        error.name = 'AbortError';
        finish(reject, error);
      } else if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`FFmpeg가 비정상 종료되었습니다. (${terminationSignal || code})\n${stderr.slice(-4000)}`));
    });
  });
}

async function detectFfmpeg(ffmpegPath, ffprobePath) {
  try {
    const [{ stdout: version }, { stdout: filters }, { stdout: encoders }] = await Promise.all([
      runProcess(ffmpegPath, ['-hide_banner', '-version']),
      runProcess(ffmpegPath, ['-hide_banner', '-filters']),
      runProcess(ffmpegPath, ['-hide_banner', '-encoders']),
      runProcess(ffprobePath, ['-hide_banner', '-version']),
    ]);
    const hasDrawtext = /\bdrawtext\b/.test(filters);
    const hasH264 = /\blibx264\b/.test(encoders);
    return {
      available: hasDrawtext && hasH264,
      engine: 'ffmpeg',
      version: version.match(/ffmpeg version\s+([^\s]+)/)?.[1] || 'unknown',
      hasDrawtext,
      hasH264,
      message: hasDrawtext && hasH264
        ? '서버 MP4 렌더링을 사용할 수 있습니다.'
        : 'FFmpeg에 drawtext 필터 또는 libx264 인코더가 없습니다.',
    };
  } catch (error) {
    return {
      available: false,
      engine: 'ffmpeg',
      version: null,
      hasDrawtext: false,
      hasH264: false,
      message: error?.code === 'ENOENT'
        ? '서버에 FFmpeg/FFprobe가 설치되어 있지 않습니다.'
        : `FFmpeg 상태를 확인하지 못했습니다: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

async function probeAsset(asset, ffprobePath, signal, processRunner = runProcess) {
  const { stdout } = await processRunner(ffprobePath, [
    '-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', asset.path,
  ], { signal });
  const payload = JSON.parse(stdout || '{}');
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  return {
    hasVideo: Boolean(video),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
  };
}

function normalizeProject(payload) {
  if (!payload || typeof payload !== 'object' || !payload.project) throw Object.assign(new Error('project 객체가 필요합니다.'), { statusCode: 400 });
  const source = payload.project;
  const canvas = source.canvas || {};
  const project = {
    title: String(source.title || 'shortform').slice(0, 200),
    canvas: {
      width: boundedNumber(canvas.width, 2, 8192, 1080),
      height: boundedNumber(canvas.height, 2, 8192, 1920),
      background: /^#[0-9a-f]{6}$/i.test(canvas.background) ? canvas.background : '#11151d',
    },
    duration: boundedNumber(source.duration, 0.1, 7200, 15),
    assets: Array.isArray(source.assets) ? source.assets.slice(0, 500).map((asset) => ({
      id: String(asset.id || ''),
      kind: ['video', 'audio', 'image'].includes(asset.kind) ? asset.kind : 'video',
      width: boundedNumber(asset.width, 0, 16384, 0),
      height: boundedNumber(asset.height, 0, 16384, 0),
    })) : [],
    clips: Array.isArray(source.clips) ? source.clips.slice(0, 1000).flatMap((clip) => {
      const sourceStart = boundedNumber(clip.sourceStart, 0, 7200, 0);
      const sourceEnd = boundedNumber(clip.sourceEnd, sourceStart + 0.01, 7200, sourceStart + 0.1);
      if (!ASSET_ID_PATTERN.test(String(clip.assetId || '')) || sourceEnd <= sourceStart) return [];
      return [{
        id: String(clip.id || randomUUID()),
        assetId: String(clip.assetId),
        trackId: clip.trackId === 'audio' ? 'audio' : 'video',
        timelineStart: boundedNumber(clip.timelineStart, 0, 7200, 0),
        sourceStart,
        sourceEnd,
        volume: boundedNumber(clip.volume, 0, 1, 1),
        reframe: clip.reframe?.enabled && Array.isArray(clip.reframe.keyframes) ? {
          enabled: true,
          keyframes: clip.reframe.keyframes.slice(0, 20_000).flatMap((keyframe) => {
            const time = Number(keyframe.time);
            const x = Number(keyframe.x);
            const y = Number(keyframe.y);
            return Number.isFinite(time) && Number.isFinite(x) && Number.isFinite(y)
              ? [{ time, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }]
              : [];
          }).sort((first, second) => first.time - second.time),
        } : null,
      }];
    }) : [],
    texts: Array.isArray(source.texts) ? source.texts.slice(0, 1000).flatMap((text) => {
      const start = boundedNumber(text.start, 0, 7200, 0);
      const end = boundedNumber(text.end, start + 0.01, 7200, start + 1);
      const value = String(text.text || '').slice(0, 2000);
      if (!value || end <= start) return [];
      return [{
        text: value,
        start,
        end,
        x: boundedNumber(text.x, 0, 100, 50),
        y: boundedNumber(text.y, 0, 100, 80),
        fontSize: boundedNumber(text.fontSize, 8, 300, 56),
        fontWeight: boundedNumber(text.fontWeight, 100, 900, 700),
        color: /^#[0-9a-f]{6}$/i.test(text.color) ? text.color : '#ffffff',
        background: /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text.background) ? text.background : '#000000bb',
        align: ['left', 'right', 'center'].includes(text.align) ? text.align : 'center',
      }];
    }) : [],
  };
  const computedEnd = Math.max(
    0.1,
    ...project.clips.map((clip) => clip.timelineStart + clip.sourceEnd - clip.sourceStart),
    ...project.texts.map((text) => text.end),
  );
  project.duration = Math.min(7200, Math.max(project.duration, computedEnd));
  const quality = payload.quality === 'hd' ? 'hd' : 'draft';
  return { project, quality };
}

function focusExpression(reframe, axis, sourceStart) {
  const keyframes = reframe?.keyframes || [];
  if (!keyframes.length) return '0.5';
  const value = (keyframe) => boundedNumber(keyframe[axis], 0, 1, 0.5).toFixed(6);
  if (keyframes.length === 1) return value(keyframes[0]);
  let expression = value(keyframes.at(-1));
  for (let index = keyframes.length - 2; index >= 0; index -= 1) {
    const first = keyframes[index];
    const next = keyframes[index + 1];
    const firstTime = Number(first.time) - sourceStart;
    const nextTime = Number(next.time) - sourceStart;
    const duration = Math.max(0.001, nextTime - firstTime);
    const interpolation = `${value(first)}+(${value(next)}-${value(first)})*(t-${firstTime.toFixed(6)})/${duration.toFixed(6)}`;
    expression = `if(lte(t,${nextTime.toFixed(6)}),${interpolation},${expression})`;
  }
  const firstLocalTime = Number(keyframes[0].time) - sourceStart;
  return `if(lte(t,${firstLocalTime.toFixed(6)}),${value(keyframes[0])},${expression})`;
}

function escapeDrawtext(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll(':', '\\:')
    .replaceAll('%', '\\%')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('\n', '\\n');
}

function ffmpegColor(value, fallback) {
  const match = String(value || '').match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!match) return fallback;
  const alpha = match[2] ? (Number.parseInt(match[2], 16) / 255).toFixed(3) : '1';
  return `0x${match[1]}@${alpha}`;
}

export function buildRenderPlan(project, assetFiles, probes, quality = 'draft') {
  const vertical = project.canvas.height >= project.canvas.width;
  const base = quality === 'hd' ? 1080 : 540;
  const width = even(vertical ? base : base * project.canvas.width / project.canvas.height);
  const height = even(vertical ? base * project.canvas.height / project.canvas.width : base);
  const targetRatio = width / height;
  const duration = project.duration;
  const inputArgs = [];
  const inputClips = [];
  for (const clip of project.clips) {
    const asset = project.assets.find((item) => item.id === clip.assetId);
    const file = assetFiles.get(clip.assetId);
    if (!asset || !file) continue;
    if (asset.kind === 'image') inputArgs.push('-loop', '1', '-framerate', '30');
    inputArgs.push('-i', file.path);
    inputClips.push({ clip, asset, inputIndex: inputClips.length, probe: probes.get(clip.assetId) || {} });
  }

  const filters = [`color=c=${ffmpegColor(project.canvas.background, '0x11151d@1')}:s=${width}x${height}:r=30:d=${duration.toFixed(3)},format=yuv420p[base0]`];
  let videoLabel = 'base0';
  let videoCount = 0;
  for (const entry of [...inputClips].reverse()) {
    const { clip, asset, inputIndex, probe } = entry;
    if (clip.trackId !== 'video' || (!probe.hasVideo && asset.kind !== 'image')) continue;
    const clipDuration = clip.sourceEnd - clip.sourceStart;
    const prepared = `visual${videoCount}`;
    const shifted = `visualShifted${videoCount}`;
    const nextBase = `base${videoCount + 1}`;
    const trim = asset.kind === 'image'
      ? `loop=loop=-1:size=1:start=0,trim=duration=${clipDuration.toFixed(6)}`
      : `trim=start=${clip.sourceStart.toFixed(6)}:end=${clip.sourceEnd.toFixed(6)}`;
    const focusX = focusExpression(clip.reframe, 'x', clip.sourceStart);
    const focusY = focusExpression(clip.reframe, 'y', clip.sourceStart);
    const scale = `scale=w='if(gt(a,${targetRatio.toFixed(9)}),-2,${width})':h='if(gt(a,${targetRatio.toFixed(9)}),${height},-2)'`;
    const crop = `crop=w=${width}:h=${height}:x='max(0,min(iw-ow,(${focusX})*iw-ow/2))':y='max(0,min(ih-oh,(${focusY})*ih-oh/2))'`;
    filters.push(`[${inputIndex}:v]${trim},setpts=PTS-STARTPTS,${scale},${crop},fps=30,format=yuv420p[${prepared}]`);
    filters.push(`[${prepared}]setpts=PTS+${clip.timelineStart.toFixed(6)}/TB[${shifted}]`);
    const clipEnd = clip.timelineStart + clipDuration;
    filters.push(`[${videoLabel}][${shifted}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:shortest=0:enable='between(t,${clip.timelineStart.toFixed(6)},${clipEnd.toFixed(6)})'[${nextBase}]`);
    videoLabel = nextBase;
    videoCount += 1;
  }

  let textCount = 0;
  for (const text of project.texts) {
    const nextLabel = `text${textCount}`;
    const fontSize = Math.max(8, Math.round(text.fontSize * width / Math.max(1, project.canvas.width)));
    const x = text.align === 'left'
      ? `(w*${(text.x / 100).toFixed(4)})`
      : text.align === 'right'
        ? `(w*${(text.x / 100).toFixed(4)}-text_w)`
        : `(w*${(text.x / 100).toFixed(4)}-text_w/2)`;
    const y = `(h*${(text.y / 100).toFixed(4)}-text_h/2)`;
    const fontStyle = text.fontWeight >= 700 ? 'Bold' : text.fontWeight >= 600 ? 'SemiBold' : 'Regular';
    const drawtext = [
      `drawtext=font='Sans\\:style=${fontStyle}'`,
      `text='${escapeDrawtext(text.text)}'`,
      'expansion=none',
      `fontcolor=${ffmpegColor(text.color, '0xffffff@1')}`,
      `fontsize=${fontSize}`,
      `x='${x}'`,
      `y='${y}'`,
      'box=1',
      `boxcolor=${ffmpegColor(text.background, '0x000000@0.733')}`,
      `boxborderw=${Math.max(3, Math.round(fontSize * 0.22))}`,
      `enable='between(t,${text.start.toFixed(6)},${text.end.toFixed(6)})'`,
    ].join(':');
    filters.push(`[${videoLabel}]${drawtext}[${nextLabel}]`);
    videoLabel = nextLabel;
    textCount += 1;
  }

  filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration.toFixed(6)}[silence]`);
  const audioLabels = ['silence'];
  let audioCount = 0;
  for (const [entryIndex, entry] of inputClips.entries()) {
    const { clip, inputIndex, probe } = entry;
    if (!probe.hasAudio) continue;
    const clipDuration = clip.sourceEnd - clip.sourceStart;
    const clipEnd = clip.timelineStart + clipDuration;
    const sameTrackBlockers = inputClips.slice(0, entryIndex).filter((candidate) => candidate.clip.trackId === clip.trackId && candidate.probe.hasAudio);
    const audioTrackBlockers = clip.trackId === 'video'
      ? inputClips.filter((candidate) => candidate.clip.trackId === 'audio' && candidate.probe.hasAudio)
      : [];
    const blockers = [...sameTrackBlockers, ...audioTrackBlockers];
    const audibleCondition = [
      `between(t,${clip.timelineStart.toFixed(6)},${clipEnd.toFixed(6)})`,
      ...blockers.map((candidate) => {
        const blockerEnd = candidate.clip.timelineStart + candidate.clip.sourceEnd - candidate.clip.sourceStart;
        return `not(between(t,${candidate.clip.timelineStart.toFixed(6)},${blockerEnd.toFixed(6)}))`;
      }),
    ].join('*');
    const label = `audio${audioCount}`;
    const delay = Math.max(0, Math.round(clip.timelineStart * 1000));
    filters.push(`[${inputIndex}:a]atrim=start=${clip.sourceStart.toFixed(6)}:end=${clip.sourceEnd.toFixed(6)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay},volume='if(${audibleCondition},${clip.volume.toFixed(6)},0)':eval=frame[${label}]`);
    audioLabels.push(label);
    audioCount += 1;
  }
  const mixInputs = audioLabels.map((label) => `[${label}]`).join('');
  filters.push(`${mixInputs}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${duration.toFixed(6)},aresample=async=1:first_pts=0[aout]`);

  const args = [
    '-hide_banner', '-y', ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', `[${videoLabel}]`, '-map', '[aout]',
    '-t', duration.toFixed(6), '-r', '30',
    '-c:v', 'libx264', '-preset', quality === 'hd' ? 'medium' : 'veryfast', '-crf', quality === 'hd' ? '20' : '25',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', quality === 'hd' ? '192k' : '128k',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
  ];
  return { args, width, height, duration, filterComplex: filters.join(';') };
}

export function createRenderService({
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  maximumUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
  maximumProjectBytes = DEFAULT_MAX_PROJECT_BYTES,
  maximumActiveJobs = 2,
  storageRoot = join(tmpdir(), `shortform-studio-render-${randomUUID()}`),
  capabilityDetector = detectFfmpeg,
  processRunner = runProcess,
} = {}) {
  const assets = new Map();
  const retiredAssets = new Set();
  const jobs = new Map();
  const cancellationRequests = new Map();
  let capabilityPromise;
  let closing = false;
  const ensureRoot = () => mkdir(storageRoot, { recursive: true });
  const assetIsInUse = (asset) => [...jobs.values()].some((job) => job.controller && job.assetPaths?.has(asset.path));
  const retireAsset = async (asset) => {
    if (!asset) return;
    if (assetIsInUse(asset)) retiredAssets.add(asset);
    else await rm(asset.path, { force: true }).catch(() => undefined);
  };
  const capabilities = () => {
    capabilityPromise ||= capabilityDetector(ffmpegPath, ffprobePath);
    return capabilityPromise;
  };

  async function processJob(job, project, jobAssets) {
    if (job.status === 'cancelled') return;
    const capability = await capabilities();
    if (job.status === 'cancelled') return;
    if (!capability.available) throw new Error(capability.message);
    job.status = 'probing';
    job.phase = '미디어 스트림 분석 중';
    job.progress = 0.04;
    job.updatedAt = new Date().toISOString();
    const probes = new Map();
    for (const [index, asset] of [...jobAssets.values()].entries()) {
      if (job.status === 'cancelled') return;
      const probe = await probeAsset(asset, ffprobePath, job.controller.signal, processRunner);
      if (job.status === 'cancelled') return;
      probes.set(asset.id, probe);
      job.progress = 0.04 + ((index + 1) / jobAssets.size) * 0.06;
      job.updatedAt = new Date().toISOString();
    }
    const plan = buildRenderPlan(project, jobAssets, probes, job.quality);
    if (job.status === 'cancelled') return;
    job.width = plan.width;
    job.height = plan.height;
    job.status = 'rendering';
    job.phase = 'FFmpeg 타임라인 합성 중';
    job.progress = 0.1;
    job.updatedAt = new Date().toISOString();
    const progressState = { buffer: '' };
    await processRunner(ffmpegPath, [...plan.args, job.outputPath], {
      signal: job.controller.signal,
      onChild: (child) => { job.child = child; },
      onStdout: (value) => {
        progressState.buffer += value;
        const lines = progressState.buffer.split(/\r?\n/);
        progressState.buffer = lines.pop() || '';
        for (const line of lines) {
          const [key, rawValue] = line.split('=', 2);
          if (key === 'out_time_ms') {
            const seconds = Number(rawValue) / 1_000_000;
            if (Number.isFinite(seconds)) job.progress = Math.min(0.98, 0.1 + seconds / Math.max(0.1, job.duration) * 0.88);
          }
        }
        job.updatedAt = new Date().toISOString();
      },
    });
    if (job.status === 'cancelled') return;
    const output = await stat(job.outputPath);
    if (job.status === 'cancelled') {
      await rm(job.outputPath, { force: true }).catch(() => undefined);
      return;
    }
    if (!output.size) throw new Error('FFmpeg가 빈 MP4 파일을 생성했습니다.');
    job.outputSize = output.size;
    job.status = 'completed';
    job.phase = '완료';
    job.progress = 1;
    job.updatedAt = new Date().toISOString();
    job.child = undefined;
    job.controller = undefined;
  }

  async function startJob(job, project, jobAssets) {
    try {
      await processJob(job, project, jobAssets);
    } catch (error) {
      if (job.status === 'cancelled' || error?.name === 'AbortError') {
        await rm(job.outputPath, { force: true }).catch(() => undefined);
        return;
      }
      job.status = 'failed';
      job.phase = '실패';
      job.progress = 1;
      job.error = error instanceof Error ? error.message : 'MP4 렌더링에 실패했습니다.';
      job.updatedAt = new Date().toISOString();
      await rm(job.outputPath, { force: true }).catch(() => undefined);
    } finally {
      job.child = undefined;
      job.controller = undefined;
      for (const asset of retiredAssets) {
        if (!assetIsInUse(asset)) {
          retiredAssets.delete(asset);
          await rm(asset.path, { force: true }).catch(() => undefined);
        }
      }
    }
  }

  async function handleRequest(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/render/health') {
      sendJson(response, 200, { status: 'ok', ...(await capabilities()), maxUploadBytes: maximumUploadBytes });
      return true;
    }

    // Audio extraction: upload media → FFmpeg → return PCM WAV for browser analysis
    if (request.method === 'POST' && url.pathname === '/api/audio/extract') {
      try {
        if (closing) throw Object.assign(new Error('서비스가 종료 중입니다.'), { statusCode: 503 });
        const capability = await capabilities();
        if (!capability.available) throw Object.assign(new Error('FFmpeg가 설치되어 있지 않습니다.'), { statusCode: 503 });
        const contentLength = Number(request.headers['content-length'] || 0);
        if (contentLength > maximumUploadBytes) throw Object.assign(new Error('파일이 너무 큽니다.'), { statusCode: 413 });
        await ensureRoot();
        const inputPath = join(storageRoot, `extract-${randomUUID()}.input`);
        const outputPath = join(storageRoot, `extract-${randomUUID()}.wav`);
        const writeStream = createWriteStream(inputPath);
        let received = 0;
        await new Promise((resolve, reject) => {
          request.on('data', (chunk) => {
            received += chunk.length;
            if (received > maximumUploadBytes) { writeStream.destroy(); reject(Object.assign(new Error('파일이 너무 큽니다.'), { statusCode: 413 })); }
            else writeStream.write(chunk);
          });
          request.on('end', () => { writeStream.end(resolve); });
          request.on('error', reject);
        });
        // Extract audio as 16kHz mono WAV (smallest useful format for analysis)
        await processRunner(ffmpegPath, [
          '-hide_banner', '-y', '-i', inputPath,
          '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
          outputPath,
        ]);
        const wavStat = await stat(outputPath);
        response.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wavStat.size,
          'Cache-Control': 'no-store',
        });
        const readStream = createReadStream(outputPath);
        readStream.pipe(response);
        readStream.on('end', async () => {
          await rm(inputPath, { force: true }).catch(() => {});
          await rm(outputPath, { force: true }).catch(() => {});
        });
        return true;
      } catch (error) {
        const status = error.statusCode || 500;
        sendJson(response, status, { error: error.message || '오디오 추출에 실패했습니다.' });
        return true;
      }
    }

    const assetMatch = url.pathname.match(/^\/api\/render\/assets\/([a-zA-Z0-9_-]{1,128})$/);
    if (assetMatch) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: '허용되지 않은 메서드입니다.' });
        return true;
      }
      try {
        if (closing) throw Object.assign(new Error('렌더 서비스가 종료 중입니다.'), { statusCode: 503 });
        const mimeType = String(request.headers['content-type'] || 'application/octet-stream').split(';')[0];
        if (!['video/', 'audio/', 'image/'].some((prefix) => mimeType.startsWith(prefix))) {
          sendJson(response, 415, { error: '영상, 오디오 또는 이미지 파일만 렌더 자산으로 업로드할 수 있습니다.' });
          return true;
        }
        await ensureRoot();
        const id = assetMatch[1];
        const encodedName = String(request.headers['x-file-name'] || id);
        let decodedName = encodedName;
        try { decodedName = decodeURIComponent(encodedName); } catch { /* use raw header */ }
        const fileName = safeName(decodedName, id);
        const extension = MIME_EXTENSIONS.get(mimeType) || extname(fileName).slice(0, 12) || '.bin';
        const path = join(storageRoot, `${id}-${randomUUID()}${extension}`);
        const size = await writeUpload(request, path, maximumUploadBytes);
        const asset = { id, path, fileName, mimeType, size, uploadedAt: new Date().toISOString() };
        const previousAsset = assets.get(id);
        assets.set(id, asset);
        await retireAsset(previousAsset);
        sendJson(response, 201, publicAsset(asset));
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error instanceof Error ? error.message : '렌더 자산 업로드에 실패했습니다.' });
      }
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/render/jobs') {
      try {
        const mimeType = String(request.headers['content-type'] || '').split(';')[0];
        if (mimeType !== 'application/json') {
          sendJson(response, 415, { error: '렌더 Job은 application/json 요청만 지원합니다.' });
          return true;
        }
        const body = await readRequestBody(request, maximumProjectBytes);
        let payload;
        try { payload = JSON.parse(body.toString('utf8')); } catch { throw Object.assign(new Error('렌더 프로젝트 JSON이 올바르지 않습니다.'), { statusCode: 400 }); }
        if (closing) throw Object.assign(new Error('렌더 서비스가 종료 중입니다.'), { statusCode: 503 });
        const requestedJobId = payload.jobId === undefined ? randomUUID() : String(payload.jobId);
        if (!JOB_ID_PATTERN.test(requestedJobId)) throw Object.assign(new Error('jobId는 UUID 형식이어야 합니다.'), { statusCode: 400 });
        if (jobs.has(requestedJobId)) throw Object.assign(new Error('이미 존재하는 렌더 Job ID입니다.'), { statusCode: 409 });
        if (cancellationRequests.has(requestedJobId)) throw Object.assign(new Error('이미 취소된 렌더 Job 요청입니다.'), { statusCode: 409 });
        const activeJobCount = [...jobs.values()].filter((job) => job.controller).length;
        if (activeJobCount >= maximumActiveJobs) throw Object.assign(new Error('동시에 실행할 수 있는 렌더 Job 수를 초과했습니다.'), { statusCode: 429 });
        const { project, quality } = normalizeProject(payload);
        const usedIds = new Set(project.clips.map((clip) => clip.assetId));
        const missing = [...usedIds].filter((id) => !assets.has(id));
        if (missing.length) throw Object.assign(new Error(`업로드되지 않은 렌더 자산이 있습니다: ${missing.join(', ')}`), { statusCode: 409 });
        await ensureRoot();
        if (cancellationRequests.has(requestedJobId)) throw Object.assign(new Error('렌더 Job 요청이 취소되었습니다.'), { statusCode: 409 });
        const id = requestedJobId;
        const now = new Date().toISOString();
        const jobAssets = new Map([...usedIds].map((assetId) => [assetId, assets.get(assetId)]));
        const job = {
          id,
          status: 'queued',
          progress: 0,
          phase: '대기 중',
          quality,
          width: 0,
          height: 0,
          duration: project.duration,
          assetCount: jobAssets.size,
          assetPaths: new Set([...jobAssets.values()].map((asset) => asset.path)),
          fileName: `${safeName(project.title)}.mp4`,
          outputPath: join(storageRoot, `${id}.mp4`),
          outputSize: 0,
          createdAt: now,
          updatedAt: now,
          error: null,
          controller: new AbortController(),
          child: undefined,
        };
        jobs.set(id, job);
        sendJson(response, 202, publicJob(job));
        job.promise = startJob(job, project, jobAssets);
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error instanceof Error ? error.message : '렌더 Job 생성에 실패했습니다.' });
      }
      return true;
    }

    const resultMatch = url.pathname.match(/^\/api\/render\/jobs\/([0-9a-f-]+)\/result$/i);
    if (resultMatch) {
      const job = jobs.get(resultMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: '렌더 Job을 찾을 수 없습니다.' });
        return true;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '허용되지 않은 메서드입니다.' });
        return true;
      }
      if (job.status !== 'completed') {
        sendJson(response, 409, { error: 'MP4 결과가 아직 준비되지 않았습니다.' });
        return true;
      }
      try {
        const output = await stat(job.outputPath);
        response.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': output.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.fileName)}`,
          'Cache-Control': 'private, max-age=3600',
        });
        const stream = createReadStream(job.outputPath);
        stream.once('error', () => response.destroy());
        stream.pipe(response);
      } catch {
        sendJson(response, 410, { error: '렌더 결과 파일이 만료되었거나 삭제되었습니다.' });
      }
      return true;
    }

    const jobMatch = url.pathname.match(/^\/api\/render\/jobs\/([0-9a-f-]+)$/i);
    if (!jobMatch) return false;
    const jobId = jobMatch[1];
    const job = jobs.get(jobId);
    if (!job) {
      if (request.method === 'DELETE' && JOB_ID_PATTERN.test(jobId)) {
        cancellationRequests.set(jobId, Date.now());
        sendJson(response, 200, { id: jobId, status: 'cancelled', progress: 1, phase: '취소됨', format: 'mp4' });
      } else sendJson(response, 404, { error: '렌더 Job을 찾을 수 없습니다.' });
      return true;
    }
    if (request.method === 'GET') {
      sendJson(response, 200, publicJob(job));
      return true;
    }
    if (request.method === 'DELETE') {
      if (!TERMINAL_STATUSES.has(job.status)) {
        job.status = 'cancelled';
        job.phase = '취소됨';
        job.progress = 1;
        job.updatedAt = new Date().toISOString();
        job.controller?.abort();
        if (job.child && !job.child.killed) job.child.kill('SIGTERM');
        await rm(job.outputPath, { force: true }).catch(() => undefined);
      }
      sendJson(response, 200, publicJob(job));
      return true;
    }
    sendJson(response, 405, { error: '허용되지 않은 메서드입니다.' });
    return true;
  }

  const cleanupTimer = setInterval(async () => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, job] of jobs) {
      if (TERMINAL_STATUSES.has(job.status) && Date.parse(job.updatedAt) < cutoff) {
        jobs.delete(id);
        await rm(job.outputPath, { force: true }).catch(() => undefined);
      }
    }
    for (const [id, asset] of assets) {
      if (Date.parse(asset.uploadedAt) < cutoff && !assetIsInUse(asset)) {
        assets.delete(id);
        await rm(asset.path, { force: true }).catch(() => undefined);
      }
    }
    for (const asset of retiredAssets) {
      if (!assetIsInUse(asset)) {
        retiredAssets.delete(asset);
        await rm(asset.path, { force: true }).catch(() => undefined);
      }
    }
    for (const [id, requestedAt] of cancellationRequests) {
      if (requestedAt < cutoff) cancellationRequests.delete(id);
    }
  }, 10 * 60 * 1000);
  cleanupTimer.unref?.();

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(cleanupTimer);
    for (const job of jobs.values()) {
      if (job.controller && !TERMINAL_STATUSES.has(job.status)) {
        job.status = 'cancelled';
        job.phase = '서비스 종료로 취소됨';
        job.progress = 1;
        job.updatedAt = new Date().toISOString();
        job.controller.abort();
      }
    }
    await Promise.allSettled([...jobs.values()].map((job) => job.promise).filter(Boolean));
    await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return { handleRequest, assets, jobs, capabilities, storageRoot, close };
}
