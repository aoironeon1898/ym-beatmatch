// ym-beatmatch: DJ-style transitions (design doc + docs/adr/0001).
import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { onMenu } from './menu';
import { renderer } from './renderer';

import type { BeatmatchConfig } from './types';

export type { BeatmatchConfig } from './types';

export const defaultConfig: BeatmatchConfig = {
  enabled: false,
  mode: 'bgm',
  maxTempoDiff: 0.08,
  overlapBeats: 16,
  rampBeats: 4,
  tailReleaseBeats: 2,
  handoffBudgetSec: 14,
  maxNudge: 0.02,
  crossfadeSec: 8,
  normalFadeSec: 2,
  minConfidence: 0.6,
  alignDownbeat: true,
  shortcutToggle: 'CmdOrCtrl+Shift+B',
  globalShortcut: false,
  cacheMaxEntries: 1000,
  debugLog: false,
};

export default createPlugin<unknown, unknown, unknown, BeatmatchConfig>({
  name: () => t('plugins.beatmatch.name'),
  description: () => t('plugins.beatmatch.description'),
  restartNeeded: true,
  config: defaultConfig,
  menu: onMenu,
  backend,
  renderer,
});
