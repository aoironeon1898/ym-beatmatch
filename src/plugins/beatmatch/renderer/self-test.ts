// Debug-only self test (runs when `debugLog` is on). Verifies on a real session that
//  1) audio flows through the core-patched graph (mixBus),
//  2) the shared Innertube session can fetch the current track,
//  3) the fetched version matches what YTM plays (P21 duration check).
// Results go to <userData>/beatmatch-log.jsonl.
import { IPC, type FetchResult } from '../types';

import type { AudioGraph } from './index';
import type { MusicPlayer } from '@/types/music-player';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Max |fetched − played| duration before we treat it as a different version (P21). */
export const VERSION_MISMATCH_SEC = 1;

export const runSelfTest = async (
  graph: AudioGraph,
  api: MusicPlayer,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  log: (entry: Record<string, unknown>) => void,
) => {
  const video = document.querySelector('video');
  if (!video) return;

  // wait for playback (nudging once if a track is loaded but paused)
  for (let i = 0; i < 40 && (video.paused || video.readyState < 3); i++) {
    if (i === 16 && api.getVideoData()?.video_id) api.playVideo();
    await sleep(500);
  }
  if (video.paused) {
    log({ kind: 'selftest', ok: false, reason: 'not-playing' });
    return;
  }

  const analyser = graph.audioContext.createAnalyser();
  analyser.fftSize = 2048;
  graph.mixBus.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    analyser.getFloatTimeDomainData(buf);
    for (const v of buf) sum += v * v;
    n += buf.length;
  }
  graph.mixBus.disconnect(analyser);
  const mixBusRms = Math.sqrt(sum / n);

  const videoId = api.getVideoData()?.video_id;
  const result = videoId ? ((await invoke(IPC.fetchAudio, videoId)) as FetchResult) : null;
  const durationDiffSec =
    result?.ok && result.durationSec != null
      ? Math.abs(result.durationSec - video.duration)
      : null;

  log({
    kind: 'selftest',
    ok: mixBusRms > 1e-4 && !!result?.ok,
    mainGain: graph.mainGain.gain.value,
    mixBusRms: +mixBusRms.toFixed(4),
    fetchOk: result?.ok ?? false,
    fetchReason: result && !result.ok ? result.reason : null,
    fetchMs: result ? Math.round(result.elapsedMs) : null,
    itag: result?.ok ? result.itag : null,
    durationDiffSec: durationDiffSec != null ? +durationDiffSec.toFixed(2) : null,
    versionMismatch: durationDiffSec != null ? durationDiffSec > VERSION_MISMATCH_SEC : null,
  });
};
