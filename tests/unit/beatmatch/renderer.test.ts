import { describe, expect, it } from 'vitest';

import { resetMainGain, type AudioGraph } from '@/plugins/beatmatch/renderer';

const fakeGraph = () => {
  const calls: string[] = [];
  const gain = {
    value: 0.2,
    cancelScheduledValues: (t: number) => calls.push(`cancel@${t}`),
    setValueAtTime: (v: number, t: number) => {
      calls.push(`set ${v}@${t}`);
      gain.value = v;
    },
  };
  const graph = {
    audioContext: { currentTime: 12.5 },
    mainGain: { gain },
  } as unknown as AudioGraph;
  return { graph, calls, gain };
};

describe('resetMainGain', () => {
  it('cancels pending automation and restores unity gain now', () => {
    const { graph, calls, gain } = fakeGraph();
    resetMainGain(graph);
    expect(calls).toEqual(['cancel@0', 'set 1@12.5']);
    expect(gain.value).toBe(1);
  });

  it('is a no-op without a graph', () => {
    expect(() => resetMainGain(null)).not.toThrow();
  });
});
