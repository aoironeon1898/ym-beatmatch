// Renderer entry. Phase 1: acquire the shared audio graph (core patch), check plugin
// conflicts, track the mode and guarantee the "mainGain = 1 when idle" invariant.
// Transitions are added in later phases (TransitionController).
import { runSelfTest } from './self-test';

import { IPC, type BeatmatchConfig, type BeatmatchMode } from '../types';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export interface AudioGraph {
  audioContext: AudioContext;
  mediaSource: MediaElementAudioSourceNode;
  mainGain: GainNode;
  mixBus: GainNode;
}

/** Plugins that fight beatmatch over the same job (design §11 P12, crossfade exclusion). */
export const CONFLICTING_PLUGINS = ['crossfade', 'skip-silences'] as const;

type State = {
  api: MusicPlayer | null;
  ctx: RendererContext<BeatmatchConfig> | null;
  graph: AudioGraph | null;
  mode: BeatmatchMode;
  /** true when beatmatch must not touch audio (conflict or init failure) */
  passive: boolean;
  passiveReason: string | null;
  onAudioCanPlay:
    | ((e: DocumentEventMap['peard:audio-can-play']) => void)
    | null;
};

const state: State = {
  api: null,
  ctx: null,
  graph: null,
  mode: 'bgm',
  passive: false,
  passiveReason: null,
  onAudioCanPlay: null,
};

const log = (entry: Record<string, unknown>) =>
  state.ctx?.ipc.send(IPC.log, entry);

/** Invariant (design §7): whenever beatmatch is idle or stopping, the player is at unity. */
export const resetMainGain = (graph: AudioGraph | null) => {
  if (!graph) return;
  const g = graph.mainGain.gain;
  g.cancelScheduledValues(0);
  g.setValueAtTime(1, graph.audioContext.currentTime);
};

const findConflicts = async () => {
  const conflicts: string[] = [];
  for (const id of CONFLICTING_PLUGINS) {
    if (await window.mainConfig.plugins.isEnabled(id)) conflicts.push(id);
  }
  return conflicts;
};

export const renderer = {
  async onPlayerApiReady(
    api: MusicPlayer,
    ctx: RendererContext<BeatmatchConfig>,
  ) {
    state.api = api;
    state.ctx = ctx;
    const config = await ctx.getConfig();
    state.mode = config.mode;

    const conflicts = await findConflicts();
    if (conflicts.includes('crossfade')) {
      state.passive = true;
      state.passiveReason = 'crossfade-enabled';
    }

    state.onAudioCanPlay = (e) => {
      const { audioContext, mediaSource, mainGain, mixBus } = e.detail;
      if (!mediaSource || !mainGain || !mixBus) {
        // running without the core patch: never touch audio
        state.passive = true;
        state.passiveReason = 'core-patch-missing';
        log({ kind: 'renderer-init', ok: false, reason: state.passiveReason });
        return;
      }
      if (state.graph) return; // the same graph is re-announced for every track
      state.graph = { audioContext, mediaSource, mainGain, mixBus };
      resetMainGain(state.graph);
      log({
        kind: 'renderer-init',
        ok: true,
        sampleRate: audioContext.sampleRate,
        mode: state.mode,
        passive: state.passive,
        passiveReason: state.passiveReason,
        conflicts,
      });
      if (config.debugLog) {
        const graph = state.graph;
        runSelfTest(graph, api, ctx.ipc.invoke, log).catch((error: unknown) =>
          log({ kind: 'selftest', ok: false, reason: String(error) }),
        );
      }
    };
    document.addEventListener('peard:audio-can-play', state.onAudioCanPlay);
  },

  onConfigChange(config: BeatmatchConfig) {
    if (config.mode !== state.mode) {
      state.mode = config.mode;
      log({ kind: 'mode', mode: config.mode });
    }
  },

  stop() {
    if (state.onAudioCanPlay) {
      document.removeEventListener(
        'peard:audio-can-play',
        state.onAudioCanPlay,
      );
    }
    resetMainGain(state.graph);
    state.graph = null;
    state.onAudioCanPlay = null;
    state.api = null;
    state.ctx = null;
  },
};

/** Read-only view for later phases and debugging. */
export const getRendererState = () => state as Readonly<State>;
