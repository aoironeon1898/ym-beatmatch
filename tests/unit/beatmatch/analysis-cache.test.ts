import { describe, expect, it } from 'vitest';

import {
  createAnalysisCache,
  type KeyValueStore,
} from '@/plugins/beatmatch/backend/analysis-cache';
import { ANALYSIS_VERSION, type TrackAnalysis } from '@/plugins/beatmatch/types';

const memoryStore = (initial: Record<string, unknown> = {}) => {
  const data = new Map<string, unknown>(Object.entries(initial));
  let writes = 0;
  const kv: KeyValueStore = {
    get: (key) => structuredClone(data.get(key)),
    set: (key, value) => {
      writes++;
      data.set(key, structuredClone(value));
    },
  };
  return { kv, data, writes: () => writes };
};

const analysis = (videoId: string, overrides: Partial<TrackAnalysis> = {}): TrackAnalysis => ({
  analysisVersion: ANALYSIS_VERSION,
  videoId,
  sourceItag: 774,
  durationSec: 180,
  globalBpm: 150,
  bpmCandidates: [{ bpm: 150, score: 1 }],
  confidence: 0.9,
  contentStart: 0.1,
  contentEnd: 179,
  intro: null,
  outro: null,
  loudness: { introDb: -12, outroDb: -10 },
  tempoStable: true,
  analyzedAt: 0,
  ...overrides,
});

describe('createAnalysisCache', () => {
  it('returns null for unknown videoIds', () => {
    const cache = createAnalysisCache(memoryStore().kv, { maxEntries: 3 });
    expect(cache.get('nope')).toBeNull();
  });

  it('stores and returns an analysis', () => {
    const cache = createAnalysisCache(memoryStore().kv, { maxEntries: 3 });
    cache.put(analysis('a'));
    expect(cache.get('a')?.globalBpm).toBe(150);
    expect(cache.size).toBe(1);
  });

  it('persists across instances (restart)', () => {
    const store = memoryStore();
    createAnalysisCache(store.kv, { maxEntries: 3 }).put(analysis('a'));
    const reopened = createAnalysisCache(store.kv, { maxEntries: 3 });
    expect(reopened.get('a')?.videoId).toBe('a');
  });

  it('evicts the least recently used entry when full', () => {
    const cache = createAnalysisCache(memoryStore().kv, { maxEntries: 2 });
    cache.put(analysis('a'));
    cache.put(analysis('b'));
    cache.get('a'); // a becomes most recent
    cache.put(analysis('c'));
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('c')).not.toBeNull();
    expect(cache.size).toBe(2);
  });

  it('overwrites an existing entry without growing', () => {
    const cache = createAnalysisCache(memoryStore().kv, { maxEntries: 2 });
    cache.put(analysis('a', { globalBpm: 100 }));
    cache.put(analysis('a', { globalBpm: 200 }));
    expect(cache.size).toBe(1);
    expect(cache.get('a')?.globalBpm).toBe(200);
  });

  it('drops entries from another analysis version', () => {
    const stale = { ...analysis('a'), analysisVersion: 0 };
    const store = memoryStore({ analysis: { order: ['a'], entries: { a: stale } } });
    const cache = createAnalysisCache(store.kv, { maxEntries: 2 });
    expect(cache.get('a')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('ignores corrupted persisted data', () => {
    const store = memoryStore({ analysis: { order: ['ghost'], entries: 'broken' } });
    const cache = createAnalysisCache(store.kv, { maxEntries: 2 });
    expect(cache.size).toBe(0);
    cache.put(analysis('a'));
    expect(cache.get('a')).not.toBeNull();
  });

  it('clear() empties the cache and persists it', () => {
    const store = memoryStore();
    const cache = createAnalysisCache(store.kv, { maxEntries: 2 });
    cache.put(analysis('a'));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(createAnalysisCache(store.kv, { maxEntries: 2 }).get('a')).toBeNull();
  });

  it('does not write on reads of valid entries', () => {
    const store = memoryStore();
    const cache = createAnalysisCache(store.kv, { maxEntries: 2 });
    cache.put(analysis('a'));
    const before = store.writes();
    cache.get('a');
    expect(store.writes()).toBe(before);
  });
});
