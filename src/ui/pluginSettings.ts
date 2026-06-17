import type { App } from 'obsidian';

interface AppSettingApi {
  open(): void;
  openTabById(id: string): void;
  containerEl?: { isShown?: () => boolean };
  plugin?: { manifest?: { id?: string } };
}

/** Survives plugin hot-reload within the same Obsidian session. */
let reopenSettingsOnNextLoad = false;

export function markReopenSettingsIfActive(app: App, pluginId: string): void {
  reopenSettingsOnNextLoad = isPluginSettingsActive(app, pluginId);
}

export function consumeReopenSettingsFlag(): boolean {
  const value = reopenSettingsOnNextLoad;
  reopenSettingsOnNextLoad = false;
  return value;
}

export function isPluginSettingsActive(app: App, pluginId: string): boolean {
  const setting = (app as App & { setting?: AppSettingApi }).setting;
  if (!setting) return false;
  const shown = setting.containerEl?.isShown?.() ?? false;
  if (!shown) return false;
  return setting.plugin?.manifest?.id === pluginId;
}

export function openPluginSettings(app: App, pluginId: string): void {
  const setting = (app as App & { setting: AppSettingApi }).setting;
  setting.open();
  setting.openTabById(pluginId);
}
