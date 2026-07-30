/**
 * Silence Detection Worker
 * Performs RMS-based silence analysis off the main thread.
 *
 * Input message: { channelData: Float32Array[], sampleRate, thresholdDb, minimumDuration, padding }
 * Output messages:
 *   { type: 'progress', progress: number }
 *   { type: 'result', candidates: Array }
 *   { type: 'error', message: string }
 */
self.onmessage = function (event) {
  try {
    const { channelData, sampleRate, thresholdDb, minimumDuration, padding } = event.data;
    const threshold = 10 ** (thresholdDb / 20);
    const frameDuration = 0.025;
    const frameSize = Math.max(1, Math.round(sampleRate * frameDuration));
    const sampleStride = Math.max(1, Math.floor(sampleRate / 8000));
    const totalSamples = channelData[0].length;
    const frameCount = Math.ceil(totalSamples / frameSize);
    const rawRanges = [];
    let silentStart = null;
    let lastProgressReport = -1;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const startSample = frameIndex * frameSize;
      const endSample = Math.min(totalSamples, startSample + frameSize);
      let squaredTotal = 0;
      let sampleCount = 0;
      for (const channel of channelData) {
        for (let sample = startSample; sample < endSample; sample += sampleStride) {
          squaredTotal += channel[sample] * channel[sample];
          sampleCount += 1;
        }
      }
      const rms = sampleCount ? Math.sqrt(squaredTotal / sampleCount) : 0;
      const frameStart = startSample / sampleRate;
      const frameEnd = endSample / sampleRate;

      if (rms <= threshold) {
        if (silentStart === null) silentStart = frameStart;
      } else if (silentStart !== null) {
        rawRanges.push({ start: silentStart, end: frameStart });
        silentStart = null;
      }

      if (frameIndex === frameCount - 1 && silentStart !== null) {
        rawRanges.push({ start: silentStart, end: frameEnd });
      }

      // Report progress every ~2%
      const progressStep = Math.floor((frameIndex / frameCount) * 50);
      if (progressStep > lastProgressReport) {
        lastProgressReport = progressStep;
        self.postMessage({ type: 'progress', progress: frameIndex / frameCount });
      }
    }

    const candidates = rawRanges
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

    self.postMessage({ type: 'result', candidates });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '침묵 분석 중 오류 발생' });
  }
};
