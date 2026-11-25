import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app, globalShortcut, type BrowserWindow } from 'electron';
import {
  register as registerLocalShortcut,
  unregister as unregisterLocalShortcut,
} from 'electron-localshortcut';

import {
  getInnertubeSession,
  refreshPoToken,
} from '@/providers/innertube-session';

import { createAnalysisCache, type KeyValueStore } from './analysis-cache';
import { createStreamFetcher } from './stream-fetcher';

import {
  IPC,
  type AnalysisCache,
  type BeatmatchConfig,
  type TrackAnalysis,
} from '../types';

import type { BackendContext } from '@/types/contexts';

// HACK: electron-store is ESM; same workaround as src/config/store.ts
/* oxlint-disable typescript/no-require-imports */
const Store = (
  require('electron-store') as {
    default: typeof import('electron-store').default;
  }
).default;
/* oxlint-enable typescript/no-require-imports */

let cache: AnalysisCache | null = null;
let registeredShortcut: {
  accel: string;
  global: boolean;
  win: BrowserWindow;
} | null = null;
let debugLog = false;

const logPath = () => join(app.getPath('userData'), 'beatmatch-log.jsonl');

export const writeLog = (entry: Record<string, unknown>) => {
  if (!debugLog) return;
  appendFile(
    logPath(),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
  ).catch(() => {});
};

export const clearAnalysisCache = () => cache?.clear();
export const analysisCacheSize = () => cache?.size ?? 0;

const unregisterShortcut = () => {
  if (!registeredShortcut) return;
  const { accel, global, win } = registeredShortcut;
  try {
    if (global) globalShortcut.unregister(accel);
    else unregisterLocalShortcut(win, accel);
  } catch {
    // window may already be destroyed
  }
  registeredShortcut = null;
};

const registerShortcut = (
  win: BrowserWindow,
  config: BeatmatchConfig,
  toggle: () => void,
) => {
  unregisterShortcut();
  if (!config.shortcutToggle) return;
  try {
    if (config.globalShortcut)
      globalShortcut.register(config.shortcutToggle, toggle);
    else registerLocalShortcut(win, config.shortcutToggle, toggle);
    registeredShortcut = {
      accel: config.shortcutToggle,
      global: config.globalShortcut,
      win,
    };
  } catch (error) {
    console.warn(
      '[beatmatch] could not register shortcut',
      config.shortcutToggle,
      error,
    );
  }
};

export const backend = {
  async start({
    window,
    ipc,
    getConfig,
    setConfig,
  }: BackendContext<BeatmatchConfig>) {
    const config = await getConfig();
    debugLog = config.debugLog;

    const store = new Store({
      name: 'beatmatch-cache',
    }) as unknown as KeyValueStore;
    cache = createAnalysisCache(store, { maxEntries: config.cacheMaxEntries });

    const fetcher = createStreamFetcher({
      getSession: () => getInnertubeSession(window),
      refreshPoToken: () => refreshPoToken(window),
    });

    ipc.handle(IPC.fetchAudio, async (videoId: string) => {
      const result = await fetcher.fetchAudio(videoId);
      writeLog(
        result.ok
          ? {
              kind: 'fetch',
              ok: true,
              videoId,
              itag: result.itag,
              mimeType: result.mimeType,
              durationSec: result.durationSec,
              loudnessDb: result.loudnessDb,
              elapsedMs: result.elapsedMs,
              sizeBytes: result.bytes.length,
            }
          : { kind: 'fetch', ...result },
      );
      return result;
    });
    ipc.handle(IPC.cacheGet, (videoId: string) => cache?.get(videoId) ?? null);
    ipc.handle(IPC.cachePut, (analysis: TrackAnalysis) => {
      cache?.put(analysis);
      return true;
    });
    ipc.on(IPC.log, (entry: Record<string, unknown>) => writeLog(entry));

    const toggleMode = async () => {
      const current = await getConfig();
      const mode = current.mode === 'bgm' ? 'normal' : 'bgm';
      await setConfig({ mode });
      writeLog({ kind: 'mode', mode, via: 'shortcut' });
    };
    registerShortcut(window, config, () => {
      toggleMode().catch((error: unknown) =>
        console.warn('[beatmatch] toggle failed', error),
      );
    });
    writeLog({ kind: 'backend-start', cacheSize: cache.size });

    // Dev hook: BEATMATCH_SELFTEST_VIDEO=<videoId> opens that track's radio once on start
    // so the debug self test can run without user interaction.
    const seed = process.env.BEATMATCH_SELFTEST_VIDEO;
    if (seed && /^[\w-]{11}$/.test(seed)) {
      const open = () => {
        window.webContents
          .loadURL(
            `https://music.\u0079\u006f\u0075\u0074\u0075\u0062\u0065.com/watch?v=${seed}&list=RDAMVM${seed}`,
          )
          .catch(() => {});
      };
      if (window.webContents.isLoading()) window.webContents.once('did-finish-load', open);
      else open();
    }
  },

  // Shortcut / cache-size changes take effect after restart (restartNeeded: true).
  onConfigChange(newConfig: BeatmatchConfig) {
    debugLog = newConfig.debugLog;
  },

  stop({ ipc }: BackendContext<BeatmatchConfig>) {
    unregisterShortcut();
    ipc.removeHandler(IPC.fetchAudio);
    ipc.removeHandler(IPC.cacheGet);
    ipc.removeHandler(IPC.cachePut);
    cache = null;
  },
};
