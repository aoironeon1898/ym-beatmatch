import * as config from '@/config';
import { t } from '@/i18n';

import { analysisCacheSize, clearAnalysisCache } from './backend';

import type { BeatmatchConfig } from './types';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

export const onMenu = async ({
  getConfig,
  setConfig,
  refresh,
}: MenuContext<BeatmatchConfig>): Promise<MenuTemplate> => {
  const current = await getConfig();
  const warnings: MenuTemplate = [];
  if (await config.plugins.isEnabled('crossfade')) {
    warnings.push({
      label: t('plugins.beatmatch.menu.warning-crossfade'),
      enabled: false,
    });
  }
  if (await config.plugins.isEnabled('skip-silences')) {
    warnings.push({
      label: t('plugins.beatmatch.menu.warning-skip-silences'),
      enabled: false,
    });
  }

  return [
    ...warnings,
    ...(warnings.length ? [{ type: 'separator' } as const] : []),
    {
      label: t('plugins.beatmatch.menu.mode-bgm'),
      type: 'radio',
      checked: current.mode === 'bgm',
      click: () => setConfig({ mode: 'bgm' }),
    },
    {
      label: t('plugins.beatmatch.menu.mode-normal'),
      type: 'radio',
      checked: current.mode === 'normal',
      click: () => setConfig({ mode: 'normal' }),
    },
    {
      label: t('plugins.beatmatch.menu.shortcut', {
        shortcut: current.shortcutToggle,
      }),
      enabled: false,
    },
    { type: 'separator' },
    {
      label: t('plugins.beatmatch.menu.debug-log'),
      type: 'checkbox',
      checked: current.debugLog,
      click: (item) => setConfig({ debugLog: item.checked }),
    },
    {
      label: t('plugins.beatmatch.menu.clear-cache', {
        count: String(analysisCacheSize()),
      }),
      click: async () => {
        clearAnalysisCache();
        await refresh();
      },
    },
  ];
};
