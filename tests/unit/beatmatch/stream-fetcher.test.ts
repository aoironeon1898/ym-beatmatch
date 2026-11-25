import { describe, expect, it, vi } from 'vitest';

import {
  classifyError,
  createStreamFetcher,
} from '@/plugins/beatmatch/backend/stream-fetcher';

type FakeFormat = {
  itag: number;
  mime_type: string;
  has_audio: boolean;
  has_video: boolean;
  approx_duration_ms?: string;
};

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

const neverEndingStream = () =>
  new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
  });

const fakeInfo = ({
  status = 'OK',
  format = {
    itag: 774,
    mime_type: 'audio/webm; codecs="opus"',
    has_audio: true,
    has_video: false,
    approx_duration_ms: '123456',
  } as FakeFormat,
  download = async () => streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]),
} = {}) => ({
  playability_status: { status },
  basic_info: { duration: 124 },
  player_config: { audio_config: { loudness_db: -2.5, perceptual_loudness_db: -9.5 } },
  chooseFormat: () => format,
  download,
});

const fetcherWith = (
  getInfo: (id: string) => Promise<unknown>,
  extra: Partial<Parameters<typeof createStreamFetcher>[0]> = {},
) => {
  const refreshPoToken = vi.fn(async () => {});
  const fetcher = createStreamFetcher({
    getSession: async () => ({ music: { getInfo } }) as never,
    refreshPoToken,
    ...extra,
  });
  return { fetcher, refreshPoToken };
};

describe('classifyError', () => {
  it.each([
    [new Error('Request failed with status 403'), 'http-403'],
    [new Error('The operation was aborted'), 'timeout'],
    [new Error('Timed out'), 'timeout'],
    [new Error('something else'), 'error'],
    ['plain string 403', 'http-403'],
  ])('%s → %s', (error, reason) => {
    expect(classifyError(error)).toBe(reason);
  });
});

describe('createStreamFetcher.fetchAudio', () => {
  it('returns the concatenated bytes and metadata', async () => {
    const { fetcher } = fetcherWith(async () => fakeInfo());
    const result = await fetcher.fetchAudio('vid');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.itag).toBe(774);
    expect(result.durationSec).toBeCloseTo(123.456);
    expect(result.loudnessDb).toBe(-2.5);
    expect(result.perceptualLoudnessDb).toBe(-9.5);
  });

  it('falls back to basic_info.duration when the format has no duration', async () => {
    const { fetcher } = fetcherWith(async () =>
      fakeInfo({
        format: { itag: 251, mime_type: 'audio/webm', has_audio: true, has_video: false },
      }),
    );
    const result = await fetcher.fetchAudio('vid');
    expect(result.ok && result.durationSec).toBe(124);
  });

  it('refreshes the PoToken once and retries after HTTP 403', async () => {
    let calls = 0;
    const { fetcher, refreshPoToken } = fetcherWith(async () => {
      calls++;
      if (calls === 1) throw new Error('Response code 403');
      return fakeInfo();
    });
    const result = await fetcher.fetchAudio('vid');
    expect(result.ok).toBe(true);
    expect(refreshPoToken).toHaveBeenCalledTimes(1);
  });

  it('gives up after a second 403', async () => {
    const { fetcher, refreshPoToken } = fetcherWith(async () => {
      throw new Error('403 forbidden');
    });
    const result = await fetcher.fetchAudio('vid');
    expect(result).toMatchObject({ ok: false, reason: 'http-403' });
    expect(refreshPoToken).toHaveBeenCalledTimes(1);
  });

  it('reports login-required without retrying', async () => {
    const { fetcher, refreshPoToken } = fetcherWith(async () =>
      fakeInfo({ status: 'LOGIN_REQUIRED' }),
    );
    expect(await fetcher.fetchAudio('vid')).toMatchObject({ ok: false, reason: 'login-required' });
    expect(refreshPoToken).not.toHaveBeenCalled();
  });

  it('reports unplayable status', async () => {
    const { fetcher } = fetcherWith(async () => fakeInfo({ status: 'UNPLAYABLE' }));
    expect(await fetcher.fetchAudio('vid')).toMatchObject({ ok: false, reason: 'unplayable' });
  });

  it('rejects formats that contain video', async () => {
    const { fetcher } = fetcherWith(async () =>
      fakeInfo({
        format: { itag: 18, mime_type: 'video/mp4', has_audio: true, has_video: true },
      }),
    );
    expect(await fetcher.fetchAudio('vid')).toMatchObject({ ok: false, reason: 'no-audio-format' });
  });

  it('enforces maxBytes', async () => {
    const { fetcher } = fetcherWith(async () => fakeInfo(), { maxBytes: 2 });
    expect(await fetcher.fetchAudio('vid')).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('times out a stalled download', async () => {
    const { fetcher } = fetcherWith(
      async () => fakeInfo({ download: async () => neverEndingStream() }),
      { timeoutMs: 30 },
    );
    expect(await fetcher.fetchAudio('vid')).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('runs downloads one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const { fetcher } = fetcherWith(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return fakeInfo();
    });
    await Promise.all([fetcher.fetchAudio('a'), fetcher.fetchAudio('b'), fetcher.fetchAudio('c')]);
    expect(maxActive).toBe(1);
  });
});
