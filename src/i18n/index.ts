import type { LanguageSetting } from '../settings';
import { en } from './en';
import { zhCN } from './zh-CN';
import type { I18nStrings } from './types';

export type { I18nStrings };

export function resolveLanguage(setting: LanguageSetting): 'zh-CN' | 'en' {
  if (setting === 'zh-CN' || setting === 'en') return setting;
  const obsidianLang =
    typeof window !== 'undefined' ? window.localStorage.getItem('language') : null;
  if (obsidianLang?.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export function getStrings(language: LanguageSetting): I18nStrings {
  return resolveLanguage(language) === 'zh-CN' ? zhCN : en;
}
