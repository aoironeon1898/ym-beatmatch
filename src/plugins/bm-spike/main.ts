import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { buildURL, getHeaders } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { app, type BrowserWindow } from 'electron';
import { Innertube, UniversalCache } from 'youtubei.js';

import { getNetFetchAsFetch } from '@/plugins/utils/main';

import type { BmSpikeConfig } from './index';
import type { BackendContext } from '@/types/contexts';

const logPath = () => join(app.getPath('userData'), 'bmspike-log.jsonl');

const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(logPath(), line + '\n');
  console.log('[bmspike]', line);
};

const getCookie = async (win: BrowserWindow) =>
  (
    await win.webContents.session.cookies.get({
      url: 'https://music.youtube.com',
    })
  )
    .map((it) => it.name + '=' + it.value)
    .join(';');

// Copied from downloader/main/index.ts (spike only; Phase 1 extracts a shared provider)
const createSession = async (win: BrowserWindow) => {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    cookie: await getCookie(win),
    generate_session_locally: true,
    fetch: getNetFetchAsFetch(),
  });
  const visitorData = yt.session.context.client.visitorData;
  let poToken = false;
  if (visitorData) {
    const g = globalThis as Record<string, unknown>;
    try {
      const [width, height] = win.getSize();
      const window = new (await import('happy-dom')).Window({
        width,
        height,
        console,
        settings: { enableIframePageLoading: true },
      });
      Object.assign(g, { window, document: window.document });
      const fetchFunction = getNetFetchAsFetch();
      const requestKey = 'O43z0dpjhgX20SCx4KAo';
      const bg = await getChallenge({ requestKey, fetchFunction });
      const js = bg.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
      if (js) {
        // oxlint-disable-next-line typescript/no-implied-eval
        new Function(js)();
        const botguard = await BotGuardClient.create({
          program: bg.program,
          globalName: bg.globalName,
          globalObject: globalThis,
        });
        const webPoSignalOutput: unknown[] = [];
        const snapshot = await botguard.snapshot({ webPoSignalOutput } as never);
        const res = await fetchFunction(buildURL('GenerateIT'), {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify([requestKey, snapshot]),
        });
        const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
          (await res.json()) as [string, number, number, string];
        const minter = await WebPoMinter.create(
          { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
          webPoSignalOutput as never,
        );
        yt.session.po_token = await minter.mintAsWebsafeString(visitorData);
        poToken = true;
        log({ kind: 'session', poToken, estimatedTtlSecs });
      }
    } catch (e) {
      log({ kind: 'session-error', error: String(e) });
    } finally {
      delete g.window;
      delete g.document;
    }
  }
  if (!poToken) log({ kind: 'session', poToken });
  return yt;
};

export const onMainLoad = ({ window, ipc }: BackendContext<BmSpikeConfig>) => {
  let session: Promise<Innertube> | null = null;
  const getYt = () => (session ??= createSession(window));

  log({ kind: 'start', logPath: logPath() });

  ipc.on('bmspike:log', (entry: Record<string, unknown>) => log(entry));

  // Auto mode: if nothing is playing shortly after start, open a radio for a seed track.
  let autoStarted = false;
  ipc.on('bmspike:autoplay-start', (seedId: string) => {
    if (autoStarted || !seedId) return;
    autoStarted = true;
    const url = `https://music.youtube.com/watch?v=${encodeURIComponent(seedId)}&list=RDAMVM${encodeURIComponent(seedId)}`;
    log({ kind: 'auto-start', seedId });
    void window.webContents.loadURL(url);
  });

  ipc.handle('bmspike:fetch', async (videoId: string) => {
    const t0 = performance.now();
    try {
      const yt = await getYt();
      const tInfo = performance.now();
      const info = await yt.music.getInfo(videoId);
      const opts = { type: 'audio', quality: 'best', format: 'any' } as const;
      const fmt = info.chooseFormat(opts);
      const stream = await info.download(opts);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > 30e6) throw new Error('too-large');
      }
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        bytes.set(c, o);
        o += c.length;
      }
      const raw = info as unknown as {
        player_config?: { audio_config?: unknown };
        playability_status?: { status?: string };
        basic_info?: { id?: string; title?: string; duration?: number };
      };
      const f = fmt as unknown as { approx_duration_ms?: number; content_length?: number; url?: string };
      return {
        ok: true,
        videoId,
        infoId: raw.basic_info?.id ?? null,
        infoTitle: raw.basic_info?.title ?? null,
        infoDurationSec: raw.basic_info?.duration ?? null,
        fmtApproxDurationMs: f.approx_duration_ms ?? null,
        fmtContentLength: f.content_length ?? null,
        fmtUrlId: f.url ? new URL(f.url).searchParams.get('id') : null,
        itag: fmt.itag,
        mime: fmt.mime_type,
        bitrate: fmt.bitrate,
        bytes,
        sessionMs: tInfo - t0,
        totalMs: performance.now() - t0,
        audioConfig: raw.player_config?.audio_config ?? null,
        playability: raw.playability_status?.status ?? null,
      };
    } catch (e) {
      return { ok: false, videoId, error: String(e), totalMs: performance.now() - t0 };
    }
  });
};
