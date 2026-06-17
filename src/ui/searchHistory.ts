import type { SearchHit } from '../index/types';

export interface SearchHistoryEntry {
  id: string;
  query: string;
  scopePath: string;
  timestamp: number;
  hits: SearchHit[];
  article: string | null;
}

export const MAX_SEARCH_HISTORY = 50;

export function createHistoryEntry(
  query: string,
  scopePath: string,
  hits: SearchHit[],
  article: string | null,
): SearchHistoryEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    query,
    scopePath,
    timestamp: Date.now(),
    hits: hits.map((hit) => ({ ...hit })),
    article,
  };
}

export function normalizeSearchHistory(data: unknown): SearchHistoryEntry[] {
  if (!Array.isArray(data)) return [];
  const result: SearchHistoryEntry[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.query !== 'string') continue;
    if (!Array.isArray(record.hits)) continue;
    const hits: SearchHit[] = [];
    for (const hit of record.hits) {
      if (typeof hit !== 'object' || hit === null) continue;
      const h = hit as Record<string, unknown>;
      if (typeof h.path !== 'string' || typeof h.title !== 'string') continue;
      hits.push({
        path: h.path,
        title: h.title,
        snippet: typeof h.snippet === 'string' ? h.snippet : '',
        score: typeof h.score === 'number' ? h.score : 0,
        matchPercent: typeof h.matchPercent === 'number' ? h.matchPercent : undefined,
        exactMatch: h.exactMatch === true,
      });
    }
    result.push({
      id: record.id,
      query: record.query,
      scopePath: typeof record.scopePath === 'string' ? record.scopePath : '',
      timestamp: typeof record.timestamp === 'number' ? record.timestamp : Date.now(),
      hits,
      article: typeof record.article === 'string' ? record.article : null,
    });
  }
  return result;
}

export class SearchHistoryStore {
  entries: SearchHistoryEntry[] = [];

  constructor(
    private loadData: () => Promise<unknown>,
    private saveData: (data: unknown) => Promise<void>,
  ) {}

  async load(): Promise<void> {
    const data: unknown = await this.loadData();
    if (typeof data !== 'object' || data === null) return;
    this.entries = normalizeSearchHistory((data as Record<string, unknown>).searchHistory);
  }

  async add(entry: SearchHistoryEntry): Promise<void> {
    this.entries = [entry, ...this.entries.filter((e) => e.id !== entry.id)].slice(
      0,
      MAX_SEARCH_HISTORY,
    );
    await this.persist();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
  }

  private async persist(): Promise<void> {
    const data: unknown = await this.loadData();
    const base = typeof data === 'object' && data !== null ? { ...(data as object) } : {};
    await this.saveData({ ...base, searchHistory: this.entries });
  }
}
