// videoId → audio-only bytes via the shared Innertube session (design doc §3-A).
import { Mutex } from 'async-mutex';

import type { FetchFailReason, FetchResult } from '../types';
import type { Innertube } from 'youtubei.js';

export interface StreamFetcherDeps {
  getSession: () => Promise<Innertube>;
  refreshPoToken: () => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

class FetchError extends Error {
  constructor(
    readonly reason: FetchFailReason,
    detail?: string,
  ) {
    super(detail ?? reason);
  }
}

/** Maps an unknown thrown value to a failure reason. Exported for tests. */
export const classifyError = (error: unknown): FetchFailReason => {
  if (error instanceof FetchError) return error.reason;
  const text = String((error as { message?: string })?.message ?? error);
  if (/\b403\b/.test(text)) return 'http-403';
  if (/abort|timed? ?out/i.test(text)) return 'timeout';
  return 'error';
};

const readAll = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
) => {
  const reader = stream.getReader();
  const onAbort = () => {
    reader.cancel('timeout').catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new FetchError('timeout');
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) throw new FetchError('too-large', `${total} bytes`);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

export const createStreamFetcher = (deps: StreamFetcherDeps) => {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = deps.now ?? (() => performance.now());
  // one download at a time (design: concurrency 1)
  const mutex = new Mutex();

  const fetchOnce = async (videoId: string, signal: AbortSignal) => {
    const yt = await deps.getSession();
    const info = await yt.music.getInfo(videoId);
    const status = info.playability_status?.status;
    if (status === 'LOGIN_REQUIRED') throw new FetchError('login-required');
    if (status && status !== 'OK') throw new FetchError('unplayable', status);

    const options = { type: 'audio', quality: 'best', format: 'any' } as const;
    let format;
    try {
      format = info.chooseFormat(options);
    } catch (error) {
      throw new FetchError('no-audio-format', String(error));
    }
    if (!format.has_audio || format.has_video) {
      throw new FetchError('no-audio-format', `itag ${format.itag}`);
    }
    const stream = await info.download(options);
    const bytes = await readAll(stream, maxBytes, signal);

    const audioConfig = (
      info as unknown as {
        player_config?: {
          audio_config?: {
            loudness_db?: number;
            perceptual_loudness_db?: number;
          };
        };
      }
    ).player_config?.audio_config;
    const approxMs = Number(
      (format as { approx_duration_ms?: number | string }).approx_duration_ms,
    );

    return {
      bytes,
      mimeType: format.mime_type,
      itag: format.itag,
      durationSec:
        Number.isFinite(approxMs) && approxMs > 0
          ? approxMs / 1000
          : (info.basic_info.duration ?? null),
      loudnessDb: audioConfig?.loudness_db ?? null,
      perceptualLoudnessDb: audioConfig?.perceptual_loudness_db ?? null,
    };
  };

  const fetchAudio = (videoId: string): Promise<FetchResult> =>
    mutex.runExclusive(async () => {
      const t0 = now();
      const attempt = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await Promise.race([
            fetchOnce(videoId, controller.signal),
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener(
                'abort',
                () => reject(new FetchError('timeout')),
                {
                  once: true,
                },
              ),
            ),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        let data;
        try {
          data = await attempt();
        } catch (error) {
          if (classifyError(error) !== 'http-403') throw error;
          // PoToken probably expired: regenerate once and retry
          await deps.refreshPoToken();
          data = await attempt();
        }
        return { ok: true as const, videoId, ...data, elapsedMs: now() - t0 };
      } catch (error) {
        return {
          ok: false as const,
          videoId,
          reason: classifyError(error),
          detail: String((error as { message?: string })?.message ?? error),
          elapsedMs: now() - t0,
        };
      }
    });

  return { fetchAudio };
};
