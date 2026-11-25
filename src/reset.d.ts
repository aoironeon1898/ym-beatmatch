import '@total-typescript/ts-reset';

import type * as config from './config';
import type { t } from '@/i18n';
import type { VideoDataChanged } from '@/types/video-data-changed';
import type { ipcRenderer as electronIpcRenderer } from 'electron';
import type is from 'electron-is';
import type { trustedTypes } from 'trusted-types';

declare global {
  interface Compressor {
    /**
     * Entry point for plugin audio chains. Since the ym-beatmatch core patch this is
     * actually the shared mix bus (a GainNode) typed as a media source for
     * backwards compatibility: only connect()/disconnect() may be used on it.
     */
    audioSource: MediaElementAudioSourceNode;
    audioContext: AudioContext;
    /** The real MediaElementAudioSourceNode of the YTM <video> (pre-fader; for taps). */
    mediaSource: MediaElementAudioSourceNode;
    /** Fader for the YTM player only (owned by beatmatch; default 1). */
    mainGain: GainNode;
    /** Mix bus that both the player and beatmatch voices feed into. */
    mixBus: GainNode;
  }

  interface DocumentEventMap {
    'peard:audio-can-play': CustomEvent<Compressor>;
    'videodatachange': CustomEvent<VideoDataChanged>;
  }

  interface Window {
    trustedTypes?: typeof trustedTypes;
    ipcRenderer: typeof electronIpcRenderer;
    mainConfig: typeof config;
    electronIs: typeof is;
    ELECTRON_RENDERER_URL: string | undefined;
    /**
     * Internal variable (Last interaction time)
     */
    _lact: number;
    navigation: Navigation;
    download: () => void;
    togglePictureInPicture: () => void;
    reload: () => void;
    i18n: {
      t: typeof t;
    };
  }
}

// import { Howl as _Howl } from 'howler';
declare module 'howler' {
  interface Howl {
    _sounds: {
      _paused: boolean;
      _ended: boolean;
      _id: string;
      _node: HTMLMediaElement;
    }[];
  }
}
