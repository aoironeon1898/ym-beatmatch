import SignalsmithStretch from 'signalsmith-stretch';

import type { BmSpikeConfig } from './index';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

const DECIM = 4;
const LIVE_SEC = 0.75;
const SEARCH_SEC = 0.15;
const RING_SEC = 4;

const TAP_SRC = `
class BmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.start = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || inp.length === 0) return true;
    const L = inp[0], R = inp[1] || inp[0];
    for (let i = 0; i + 3 < L.length; i += ${DECIM}) {
      if (this.n === 0) this.start = currentFrame + i;
      let s = 0;
      for (let k = 0; k < ${DECIM}; k++) s += (L[i + k] + R[i + k]) * 0.5;
      this.buf[this.n++] = s / ${DECIM};
      if (this.n === this.buf.length) {
        this.port.postMessage({ start: this.start, data: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(2048); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('bm-tap', BmTap);
`;

type Chunk = { start: number; data: Float32Array };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1));
};
const ms = (s: number) => +(s * 1000).toFixed(3);

export const onPlayerApiReady = (
  api: MusicPlayer,
  ctx: RendererContext<BmSpikeConfig>,
) => {
  const log = (entry: Record<string, unknown>) => ctx.ipc.send('bmspike:log', entry);
  const video = document.querySelector('video')!;

  let audioContext: AudioContext | null = null;
  let fs = 48000;
  const ring: Chunk[] = [];
  const coarse: number[] = [];
  let ref: { videoId: string; data: Float32Array } | null = null;
  let currentId = '';
  let busy = false;

  // ---- P16: Blob Worker inside the page
  try {
    const url = URL.createObjectURL(
      new Blob(['onmessage = (e) => postMessage(e.data * 2)'], { type: 'text/javascript' }),
    );
    const w = new Worker(url);
    w.onmessage = (e) => {
      log({ kind: 'P16-worker', ok: e.data === 42 });
      w.terminate();
    };
    w.onerror = (e) => log({ kind: 'P16-worker', ok: false, error: String(e.message) });
    w.postMessage(21);
  } catch (e) {
    log({ kind: 'P16-worker', ok: false, error: String(e) });
  }

  // ---- coarse clock samples
  // NOTE: requestAnimationFrame stops while the window is hidden/occluded, so use a timer
  // (timers are throttled in background but keep running). Also counts samples for the log.
  let coarseSamples = 0;
  setInterval(() => {
    if (audioContext && !video.paused && !video.seeking && video.readyState >= 3) {
      coarse.push(audioContext.currentTime - video.currentTime);
      coarseSamples++;
      if (coarse.length > 120) coarse.shift();
    }
  }, 50);

  const liveWindow = (sec: number): Chunk | null => {
    const need = Math.round((sec * fs) / DECIM);
    let have = 0;
    const parts: Chunk[] = [];
    for (let i = ring.length - 1; i >= 0 && have < need; i--) {
      parts.unshift(ring[i]);
      have += ring[i].data.length;
    }
    if (have < need) return null;
    const all = new Float32Array(have);
    let o = 0;
    for (const p of parts) {
      all.set(p.data, o);
      o += p.data.length;
    }
    const cut = have - need;
    return { start: parts[0].start + cut * DECIM, data: all.subarray(cut) };
  };

  const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, b) => a + b * b, 0) / (x.length || 1));

  // Normalized cross-correlation lock: returns c (ctx = c + media)
  const lock = () => {
    if (!ref || ref.videoId !== currentId || coarse.length < 15) return null;
    const live = liveWindow(LIVE_SEC);
    if (!live) return null;
    const fsd = fs / DECIM;
    const cCoarse = median(coarse.slice(-15));
    const liveStartSec = live.start / fs;
    const center = Math.round((liveStartSec - cCoarse) * fsd);
    const W = Math.round(SEARCH_SEC * fsd);
    const N = live.data.length;
    let liveE = 0;
    for (let i = 0; i < N; i++) liveE += live.data[i] * live.data[i];
    if (liveE < 1e-6) return { silent: true };
    const scores = new Float32Array(2 * W + 1).fill(-2);
    for (let lag = -W; lag <= W; lag++) {
      const s = center + lag;
      if (s < 0 || s + N > ref.data.length) continue;
      let dot = 0;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const r = ref.data[s + i];
        dot += r * live.data[i];
        e += r * r;
      }
      scores[lag + W] = dot / Math.sqrt(liveE * e + 1e-12);
    }
    let bi = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
    let second = -2;
    for (let i = 0; i < scores.length; i++) if (Math.abs(i - bi) > 6) second = Math.max(second, scores[i]);
    const y0 = scores[bi - 1] ?? scores[bi];
    const y1 = scores[bi];
    const y2 = scores[bi + 1] ?? scores[bi];
    const denom = y0 - 2 * y1 + y2;
    const frac = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const tauFine = (center + (bi - W) + frac) / fsd;
    return {
      c: liveStartSec - tauFine,
      cCoarse,
      peak: y1,
      second,
      atEdge: bi === 0 || bi === scores.length - 1,
    };
  };

  // Diagnostic: wide search (±5 s, step 2) when the normal lock keeps hitting the edge.
  const lockWide = () => {
    if (!ref || coarse.length < 15) return null;
    const live = liveWindow(0.3);
    if (!live) return null;
    const fsd = fs / DECIM;
    const cCoarse = median(coarse.slice(-15));
    const liveStartSec = live.start / fs;
    const center = Math.round((liveStartSec - cCoarse) * fsd);
    const W = Math.round(5 * fsd);
    const N = live.data.length;
    let liveE = 0;
    for (let i = 0; i < N; i++) liveE += live.data[i] * live.data[i];
    let best = -2;
    let bestLag = 0;
    for (let lag = -W; lag <= W; lag += 2) {
      const st = center + lag;
      if (st < 0 || st + N > ref.data.length) continue;
      let dot = 0;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const r = ref.data[st + i];
        dot += r * live.data[i];
        e += r * r;
      }
      const v = dot / Math.sqrt(liveE * e + 1e-12);
      if (v > best) { best = v; bestLag = lag; }
    }
    return { offsetFromCoarseMs: ms(bestLag / fsd), peak: +best.toFixed(3) };
  };

  const buildRef = (buf: AudioBuffer) => {
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const n = Math.floor(L.length / DECIM);
    const out = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < DECIM; k++) s += (L[j * DECIM + k] + R[j * DECIM + k]) * 0.5;
      out[j] = s / DECIM;
    }
    return out;
  };

  // ---- per-track: P1 fetch, P2 decode, P19 loudness, P13/item5 lock series
  const onTrack = async () => {
    const id = api.getVideoData()?.video_id;
    if (!id || id === currentId || !audioContext) return;
    currentId = id;
    ref = null;
    localStorage.setItem('bmspike:lastId', id);
    const r = (await ctx.ipc.invoke('bmspike:fetch', id)) as Record<string, unknown> & {
      ok: boolean;
      bytes?: Uint8Array;
    };
    const { bytes, ...meta } = r;
    log({ kind: 'P1-fetch', ...meta, sizeBytes: bytes?.length ?? 0 });
    if (!r.ok || !bytes) return;
    const t0 = performance.now();
    try {
      const buf = await audioContext.decodeAudioData(bytes.slice().buffer);
      log({
        kind: 'P2-decode',
        videoId: id,
        ok: true,
        decodeMs: +(performance.now() - t0).toFixed(1),
        durationSec: buf.duration,
        ytmDurationSec: video.duration,
        sampleRate: buf.sampleRate,
        channels: buf.numberOfChannels,
      });
      if (currentId !== id) return;
      ref = { videoId: id, data: buildRef(buf) };
    } catch (e) {
      log({ kind: 'P2-decode', videoId: id, ok: false, error: String(e) });
      return;
    }
    // lock series
    const cs: number[] = [];
    const diffs: number[] = [];
    const peaks: number[] = [];
    const rejects: Record<string, number> = {};
    const reject = (why: string) => (rejects[why] = (rejects[why] ?? 0) + 1);
    for (let i = 0; i < 20 && currentId === id; i++) {
      await sleep(1000);
      if (video.paused) { reject('paused'); continue; }
      if (busy) { reject('busy'); continue; }
      const l = lock();
      if (!l) { reject(coarse.length < 15 ? 'few-coarse' : 'no-live-or-ref'); continue; }
      if ('silent' in l) { reject('silent'); continue; }
      if (l.atEdge) { reject('edge'); continue; }
      if (l.peak < 0.6) { reject('low-peak'); continue; }
      cs.push(l.c);
      diffs.push(l.cCoarse - l.c);
      peaks.push(l.peak);
    }
    log({
      kind: 'P13-lock-series',
      videoId: id,
      rejects,
      coarseSamples,
      ringChunks: ring.length,
      locks: cs.length,
      fineSdMs: ms(sd(cs)),
      fineRangeMs: cs.length ? ms(Math.max(...cs) - Math.min(...cs)) : null,
      coarseMinusFineMedianMs: ms(median(diffs)),
      coarseMinusFineSdMs: ms(sd(diffs)),
      coarseJitterSdMs: ms(sd(coarse.slice(-60))),
      peakMedian: +median(peaks).toFixed(3),
      wide: cs.length === 0 ? lockWide() : undefined,
    });
    if (currentId === id) void autoAdvance();
  };

  // ---- auto mode: run playback tests once (after 2nd track), then advance until 6 tracks
  let tracksDone = 0;
  let testsDone = false;
  const AUTO_TRACKS = 6;
  const autoAdvance = async () => {
    tracksDone++;
    if (tracksDone >= 2 && !testsDone) {
      testsDone = true;
      await playbackTests();
    }
    if (tracksDone < AUTO_TRACKS) {
      log({ kind: 'auto-next', tracksDone });
      await sleep(1000);
      api.nextVideo();
    } else {
      log({ kind: 'auto-complete', tracksDone });
    }
  };

  // ---- audible tests (menu): P5 volume=0 tap, P18 playbackRate + seek
  const playbackTests = async () => {
    if (busy || !ref || ref.videoId !== currentId) {
      log({ kind: 'playback-tests', skipped: true, reason: 'no reference for current track yet' });
      return;
    }
    busy = true;
    try {
      // P5
      const before = liveWindow(0.5);
      const vol = video.volume;
      video.volume = 0;
      await sleep(700);
      const muted = liveWindow(0.5);
      video.volume = vol;
      log({
        kind: 'P5-volume0-tap',
        rmsBefore: before ? rms(before.data) : null,
        rmsAtVolume0: muted ? rms(muted.data) : null,
      });
      await sleep(1500);

      // P18 rate
      let rateChanges = 0;
      const onRate = () => rateChanges++;
      video.addEventListener('ratechange', onRate);
      const l0 = lock();
      video.playbackRate = 1.02;
      await sleep(3000);
      const rateAfter3s = video.playbackRate;
      const l1 = lock();
      video.playbackRate = 1;
      await sleep(1500);
      const l2 = lock();
      video.removeEventListener('ratechange', onRate);
      const ok = (l: unknown): l is { c: number; peak: number } =>
        !!l && typeof (l as { c?: number }).c === 'number';
      log({
        kind: 'P18-rate',
        rateAfter3s,
        rateChangeEvents: rateChanges,
        deltaC_ms_expected: -60,
        deltaC_ms_measured: ok(l0) && ok(l1) ? ms(l1.c - l0.c) : null,
        afterRestore_c_minus_l1_ms: ok(l1) && ok(l2) ? ms(l2.c - l1.c) : null,
        peaks: [l0, l1, l2].map((l) => (ok(l) ? +l.peak.toFixed(3) : null)),
      });
      await sleep(1000);

      // P18 seek x3
      for (let k = 0; k < 3; k++) {
        coarse.length = 0;
        const lb = lock() ?? (await sleep(1200), lock());
        const tCmd = audioContext!.currentTime;
        let tSeeked = NaN;
        video.addEventListener('seeked', () => (tSeeked = audioContext!.currentTime), { once: true });
        video.currentTime = video.currentTime + 0.25;
        await sleep(2000);
        const la = lock();
        log({
          kind: 'P18-seek',
          k,
          seekedLatencyMs: ms(tSeeked - tCmd),
          // instant seek would give c_after = c_before - 0.25; positive extra = stall time
          stallMs: ok(lb) && ok(la) ? ms(la.c - (lb.c - 0.25)) : null,
          peaks: [lb, la].map((l) => (ok(l) ? +l.peak.toFixed(3) : null)),
        });
        await sleep(1500);
      }
    } finally {
      busy = false;
    }
  };
  ctx.ipc.on('bmspike:run-playback-tests', () => void playbackTests());

  // ---- auto start playback without user interaction
  setTimeout(() => {
    if (!video.paused) return;
    const seed = localStorage.getItem('bmspike:lastId');
    if (video.src && api.getVideoData()?.video_id) {
      log({ kind: 'auto-play', how: 'playVideo' });
      api.playVideo();
    } else if (seed) {
      ctx.ipc.send('bmspike:autoplay-start', seed);
    } else {
      log({ kind: 'auto-play', how: 'none', reason: 'no seed track' });
    }
  }, 6000);

  // ---- audio graph
  document.addEventListener(
    'peard:audio-can-play',
    async (e) => {
      const { audioContext: ac, audioSource } = e.detail;
      audioContext = ac;
      fs = ac.sampleRate;
      log({ kind: 'ctx', sampleRate: fs, state: ac.state, baseLatency: ac.baseLatency, outputLatency: ac.outputLatency });
      try {
        await ac.audioWorklet.addModule(
          URL.createObjectURL(new Blob([TAP_SRC], { type: 'text/javascript' })),
        );
        const tap = new AudioWorkletNode(ac, 'bm-tap', { numberOfOutputs: 1, outputChannelCount: [1] });
        tap.port.onmessage = (m: MessageEvent<Chunk>) => {
          ring.push(m.data);
          let total = ring.reduce((a, c) => a + c.data.length, 0);
          while (ring.length > 1 && total - ring[0].data.length > (RING_SEC * fs) / DECIM) {
            total -= ring.shift()!.data.length;
          }
        };
        const zero = ac.createGain();
        zero.gain.value = 0;
        audioSource.connect(tap);
        tap.connect(zero).connect(ac.destination);
        log({ kind: 'P16-worklet-blob', ok: true });
      } catch (err) {
        log({ kind: 'P16-worklet-blob', ok: false, error: String(err) });
      }
      try {
        const node = await SignalsmithStretch(ac);
        const lat = await node.latency();
        log({ kind: 'signalsmith-in-page', ok: true, latencySec: lat });
        node.disconnect();
      } catch (err) {
        log({ kind: 'signalsmith-in-page', ok: false, error: String(err) });
      }
      void onTrack();
    },
    { once: true },
  );

  document.addEventListener('videodatachange', (e) => {
    if (e.detail?.name === 'dataloaded') void onTrack();
  });
};
