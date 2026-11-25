// Shared Innertube session (+ BotGuard PoToken) for the main process.
// Extracted from plugins/downloader/main (ym-beatmatch ADR-0001 / D3) so that the
// downloader and beatmatch share one session and never race on the happy-dom globals
// that PoToken generation temporarily installs on `globalThis`.
import { Mutex } from 'async-mutex';
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { buildURL, getHeaders } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { Innertube, UniversalCache } from 'youtubei.js';

import { getNetFetchAsFetch } from '@/plugins/utils/main';

import type {
  FetchFunction,
  IBotguardClientSideBgChallenge,
  IntegrityTokenData,
  WebPoSignalOutput,
} from 'bgutils-js/shared-types';
import type { BrowserWindow } from 'electron';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
/** Refresh a little before the advertised TTL runs out. */
const TTL_SAFETY_SEC = 300;

const mutex = new Mutex();
let session: Promise<Innertube> | null = null;
let poTokenExpiresAt: number | null = null; // epoch ms

export const getCookieFromWindow = async (win: BrowserWindow) =>
  (
    await win.webContents.session.cookies.get({
      url: 'https://music.youtube.com',
    })
  )
    .map((it) => it.name + '=' + it.value)
    .join(';');

const generatePoToken = async (
  fetchFunction: FetchFunction,
  identifier: string,
  { program, globalName }: IBotguardClientSideBgChallenge,
) => {
  const botguard = await BotGuardClient.create({
    program,
    globalName,
    globalObject: globalThis,
  });

  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

  const integrityTokenResponse = await fetchFunction(buildURL('GenerateIT'), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  const [
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold,
    websafeFallbackToken,
  ] = (await integrityTokenResponse.json()) as [
    IntegrityTokenData['integrityToken'],
    IntegrityTokenData['estimatedTtlSecs'],
    IntegrityTokenData['mintRefreshThreshold'],
    IntegrityTokenData['websafeFallbackToken'],
  ];

  const webPoMinter = await WebPoMinter.create(
    {
      integrityToken,
      estimatedTtlSecs,
      mintRefreshThreshold,
      websafeFallbackToken,
    },
    webPoSignalOutput,
  );

  return {
    token: await webPoMinter.mintAsWebsafeString(identifier),
    ttlSecs: estimatedTtlSecs ?? null,
  };
};

/** Installs `po_token` on the session. Must run under `mutex`. */
const applyPoToken = async (yt: Innertube, win: BrowserWindow) => {
  const visitorData = yt.session.context.client.visitorData;
  if (!visitorData) return;

  const context = globalThis as Partial<typeof globalThis>;
  const cleanUp = () => {
    delete context.window;
    delete context.document;
  };

  try {
    const [width, height] = win.getSize();
    // emulate a DOM for BotGuard
    const window = new (await import('happy-dom')).Window({
      width,
      height,
      console,
      settings: { enableIframePageLoading: true },
    });
    Object.assign(globalThis, { window, document: window.document });

    const fetchFunction = getNetFetchAsFetch();
    const bgChallenge = await getChallenge({
      requestKey: REQUEST_KEY,
      fetchFunction,
    });
    const interpreterJavascript =
      bgChallenge.interpreterJavascript
        ?.privateDoNotAccessOrElseSafeScriptWrappedValue;

    if (interpreterJavascript) {
      // oxlint-disable-next-line typescript/no-implied-eval,typescript/no-unsafe-call
      new Function(interpreterJavascript)();
      const { token, ttlSecs } = await generatePoToken(
        fetchFunction,
        visitorData,
        bgChallenge,
      );
      yt.session.po_token = token;
      const refreshInMs =
        ttlSecs != null ? Math.max(0, ttlSecs - TTL_SAFETY_SEC) * 1000 : null;
      poTokenExpiresAt = refreshInMs != null ? Date.now() + refreshInMs : null;
    }
  } catch (error) {
    console.warn('[innertube-session] PoToken generation failed', error);
  } finally {
    cleanUp();
  }
};

const createSession = (win: BrowserWindow) =>
  mutex.runExclusive(async () => {
    const yt = await Innertube.create({
      cache: new UniversalCache(false),
      cookie: await getCookieFromWindow(win),
      generate_session_locally: true,
      fetch: getNetFetchAsFetch(),
    });
    await applyPoToken(yt, win);
    return yt;
  });

/**
 * Returns the shared session, creating it on first use. If the PoToken is past its TTL
 * it is regenerated before returning.
 */
export const getInnertubeSession = async (
  win: BrowserWindow,
): Promise<Innertube> => {
  session ??= createSession(win).catch((error: unknown) => {
    session = null; // allow a retry on next call
    throw error;
  });
  const yt = await session;
  if (poTokenExpiresAt != null && Date.now() >= poTokenExpiresAt) {
    await refreshPoToken(win);
  }
  return yt;
};

/** Regenerates the PoToken (e.g. after an HTTP 403). */
export const refreshPoToken = async (win: BrowserWindow) => {
  if (!session) return;
  const yt = await session;
  await mutex.runExclusive(() => applyPoToken(yt, win));
};
