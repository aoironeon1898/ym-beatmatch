// LRU cache of TrackAnalysis keyed by videoId.
// Storage is injected (electron-store in production, a Map in tests).
import {
  ANALYSIS_VERSION,
  type AnalysisCache,
  type TrackAnalysis,
} from '../types';

export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

interface Persisted {
  /** videoIds, least recently used first */
  order: string[];
  entries: Record<string, TrackAnalysis>;
}

const KEY = 'analysis';

const isValid = (value: unknown, videoId: string): value is TrackAnalysis =>
  typeof value === 'object' &&
  value !== null &&
  (value as TrackAnalysis).analysisVersion === ANALYSIS_VERSION &&
  (value as TrackAnalysis).videoId === videoId;

export const createAnalysisCache = (
  kv: KeyValueStore,
  { maxEntries }: { maxEntries: number },
): AnalysisCache => {
  const raw = kv.get(KEY) as Partial<Persisted> | undefined;
  const state: Persisted = {
    order: Array.isArray(raw?.order) ? [...raw.order] : [],
    entries:
      raw?.entries && typeof raw.entries === 'object' ? { ...raw.entries } : {},
  };
  // drop anything inconsistent left by an older build
  state.order = state.order.filter((id) => id in state.entries);

  const persist = () => kv.set(KEY, state);
  const touch = (id: string) => {
    state.order = state.order.filter((x) => x !== id);
    state.order.push(id);
  };

  return {
    get(videoId) {
      const hit = state.entries[videoId];
      if (hit === undefined) return null;
      if (!isValid(hit, videoId)) {
        delete state.entries[videoId];
        state.order = state.order.filter((x) => x !== videoId);
        persist();
        return null;
      }
      touch(videoId);
      // LRU order is only persisted on writes to keep reads cheap
      return hit;
    },
    put(analysis) {
      state.entries[analysis.videoId] = analysis;
      touch(analysis.videoId);
      while (state.order.length > Math.max(1, maxEntries)) {
        const evicted = state.order.shift()!;
        delete state.entries[evicted];
      }
      persist();
    },
    clear() {
      state.order = [];
      state.entries = {};
      persist();
    },
    get size() {
      return state.order.length;
    },
  };
};
