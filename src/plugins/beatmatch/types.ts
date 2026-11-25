// Shared types for the beatmatch plugin (design doc §4).
// Pure type module: safe to import from main, renderer, workers and tests.

export type Seconds = number;
/** AudioContext render time [s] */
export type CtxTime = number;
/** Position from the start of a track [s] */
export type MediaTime = number;

export type BeatmatchMode = 'bgm' | 'normal';

export interface BeatmatchConfig {
  enabled: boolean;
  /** 'bgm' = beatmatch, 'normal' = short crossfade or none */
  mode: BeatmatchMode;
  /** Max |ratio − 1| for beatmatching (0.08 = ±8%) */
  maxTempoDiff: number;
  overlapBeats: 16;
  /** Tempo ramp length before the overlap (beats) */
  rampBeats: number;
  tailReleaseBeats: number;
  /** How long the B intro PCM may keep playing after the overlap [s] */
  handoffBudgetSec: number;
  /** Max |playbackRate − 1| used to pull YTM's B onto the PCM */
  maxNudge: number;
  /** Crossfade length when beatmatching is not possible in bgm mode [s] */
  crossfadeSec: number;
  /** Crossfade length in normal mode [s] (0 = no transition) */
  normalFadeSec: number;
  minConfidence: number;
  alignDownbeat: boolean;
  /** Electron accelerator for toggling bgm/normal */
  shortcutToggle: string;
  /** Register the shortcut globally (otherwise only while focused) */
  globalShortcut: boolean;
  cacheMaxEntries: number;
  /** Append JSON lines to <userData>/beatmatch-log.jsonl */
  debugLog: boolean;
}

/** Beat grid inside an analysis window. Produced by the worker, read by the planner. */
export interface BeatGrid {
  /** fitted value inside the window (not rounded) */
  bpm: number;
  period: Seconds;
  phase: MediaTime;
  beats: MediaTime[];
  downbeatIndex: 0 | 1 | 2 | 3 | null;
  downbeatConfidence: number;
  fitResidualMs: number;
  confidence: number;
}

export const ANALYSIS_VERSION = 1;

/** Analysis result per videoId (cache unit). */
export interface TrackAnalysis {
  analysisVersion: typeof ANALYSIS_VERSION;
  videoId: string;
  sourceItag: number;
  durationSec: Seconds;
  globalBpm: number;
  bpmCandidates: { bpm: number; score: number }[];
  confidence: number;
  contentStart: MediaTime;
  contentEnd: MediaTime;
  intro: BeatGrid | null;
  outro: BeatGrid | null;
  /** dBFS (approx. K-weighted RMS) */
  loudness: { introDb: number; outroDb: number };
  tempoStable: boolean;
  /** epoch ms */
  analyzedAt: number;
}

export type FetchFailReason =
  | 'unplayable'
  | 'login-required'
  | 'no-audio-format'
  | 'http-403'
  | 'timeout'
  | 'too-large'
  | 'error';

export interface FetchedAudio {
  ok: true;
  videoId: string;
  bytes: Uint8Array;
  mimeType: string;
  itag: number;
  /** duration reported for the fetched format (used to detect version mismatch, P21) */
  durationSec: Seconds | null;
  /** YTM normalisation values from player_config.audio_config (P19) */
  loudnessDb: number | null;
  perceptualLoudnessDb: number | null;
  elapsedMs: number;
}

export type FetchResult =
  | FetchedAudio
  | {
      ok: false;
      videoId: string;
      reason: FetchFailReason;
      detail?: string;
      elapsedMs: number;
    };

export interface AnalysisCache {
  /** null when missing or produced by another analysis version */
  get(videoId: string): TrackAnalysis | null;
  put(analysis: TrackAnalysis): void;
  clear(): void;
  readonly size: number;
}

/** IPC channel names (renderer ⇄ backend). */
export const IPC = {
  fetchAudio: 'beatmatch:fetch-audio',
  cacheGet: 'beatmatch:cache-get',
  cachePut: 'beatmatch:cache-put',
  log: 'beatmatch:log',
} as const;
