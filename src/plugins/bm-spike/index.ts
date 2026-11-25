// Phase 0 spike (throwaway, branch spike/phase0). Measures feasibility facts for ym-beatmatch.
import { createPlugin } from '@/utils';

import { onMainLoad } from './main';
import { onPlayerApiReady } from './renderer';

export type BmSpikeConfig = { enabled: boolean };

export default createPlugin({
  name: () => 'Beatmatch Phase0 spike',
  description: () => 'Throwaway measurements for ym-beatmatch Phase 0',
  restartNeeded: true,
  config: { enabled: true } as BmSpikeConfig,
  menu: ({ window }) => [
    {
      label: 'Phase0: run playback tests (mute / rate / seek) — audible',
      click: () => window.webContents.send('bmspike:run-playback-tests'),
    },
  ],
  backend: { start: onMainLoad },
  renderer: { onPlayerApiReady },
});
