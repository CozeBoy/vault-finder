import { Menu } from 'obsidian';
import type VaultFinderPlugin from '../main';
import { openPluginSettings } from './pluginSettings';

export function attachRibbonContextMenu(
  plugin: VaultFinderPlugin,
  ribbonEl: HTMLElement,
): void {
  plugin.registerDomEvent(ribbonEl, 'contextmenu', (evt) => {
    evt.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle(plugin.t().ribbonOpenSettings).onClick(() => {
        openPluginSettings(plugin.app, plugin.manifest.id);
      });
    });
    menu.showAtMouseEvent(evt);
  });
}
