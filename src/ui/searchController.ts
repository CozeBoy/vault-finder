import { Notice } from 'obsidian';
import { aiErrorNotice } from '../ai/apiErrors';
import { computeMatchPercents, splitHitsByThreshold } from '../index/matchScore';
import type { SearchHit } from '../index/types';
import type VaultFinderPlugin from '../main';
import { createHistoryEntry, type SearchHistoryArticleSnapshot, type SearchHistoryEntry } from './searchHistory';

export type SearchPhase = 'idle' | 'local' | 'ai-expand' | 'ai-filter' | 'ai-article';

export interface SearchPanelCallbacks {
  onStatusChange: () => void;
  onHitsChange: () => void;
  onArticleChange: (markdown: string | null, loading: boolean) => void;
  onSearchingChange: (searching: boolean) => void;
  onHistoryChange?: () => void;
  getQuery: () => string;
  getSearchScope: () => string;
  getHistoryArticleSnapshot?: () => SearchHistoryArticleSnapshot;
}

export class SearchController {
  primaryHits: SearchHit[] = [];
  weakHits: SearchHit[] = [];
  article: string | null = null;
  selectedIndex = -1;
  isSearching = false;
  searchPhase: SearchPhase = 'idle';
  private searchGeneration = 0;

  constructor(
    private plugin: VaultFinderPlugin,
    private callbacks: SearchPanelCallbacks,
  ) {}

  allHits(): SearchHit[] {
    return [...this.primaryHits, ...this.weakHits];
  }

  dispose(): void {
    this.cancelSearch();
  }

  async submitSearch(): Promise<void> {
    if (this.isSearching) return;
    await this.runSearch();
  }

  cancelSearch(): void {
    if (!this.isSearching) return;
    this.searchGeneration++;
    this.setSearching(false);
    this.setPhase('idle');
    this.callbacks.onArticleChange(null, false);
    this.callbacks.onStatusChange();
  }

  displaySnapshot(entry: SearchHistoryEntry): void {
    this.searchGeneration++;
    this.setSearching(false);
    this.setPhase('idle');
    this.applyMatchSplit(entry.hits.map((hit) => ({ ...hit })));
    this.article = entry.article;
    this.selectedIndex = -1;
    this.callbacks.onArticleChange(entry.article, false);
    this.callbacks.onHitsChange();
    this.callbacks.onStatusChange();
  }

  applyMatchSplit(rawHits: SearchHit[]): void {
    const threshold = this.plugin.settings.searchMatchThreshold;
    const { primary, weak } = splitHitsByThreshold(rawHits, threshold);
    this.primaryHits = primary;
    this.weakHits = this.plugin.settings.showWeakMatchResults ? weak : [];
  }

  async runSearch(): Promise<void> {
    const query = this.callbacks.getQuery().trim();
    const scopePath = this.callbacks.getSearchScope();
    const generation = ++this.searchGeneration;
    this.selectedIndex = -1;
    this.article = null;
    this.primaryHits = [];
    this.weakHits = [];
    this.callbacks.onArticleChange(null, false);

    if (!query) {
      this.setSearching(false);
      this.setPhase('idle');
      this.callbacks.onHitsChange();
      this.callbacks.onStatusChange();
      return;
    }

    const status = this.plugin.index.getStatus();
    if (status.isRebuilding && status.documentCount === 0) {
      this.setSearching(false);
      this.setPhase('idle');
      this.callbacks.onHitsChange();
      this.callbacks.onStatusChange();
      return;
    }

    this.setSearching(true);
    this.setPhase('local');

    try {
      let rawHits = await this.plugin.index.searchAsync([query], scopePath);
      if (generation !== this.searchGeneration) return;

      if (this.plugin.isAiActive()) {
        const hasExact = this.plugin.index.hasExactContentMatches(query, rawHits);
        if (!hasExact) {
          this.setPhase('ai-expand');
          try {
            const expanded = await this.plugin.aiService.expandKeywords(query);
            if (generation !== this.searchGeneration) return;
            if (expanded.length > 0) {
              rawHits = await this.plugin.index.searchAsync([query, ...expanded], scopePath);
            }
          } catch (error) {
            if (!this.plugin.settings.aiFallbackToLocal) {
              new Notice(aiErrorNotice(this.plugin.t().searchAiFailed, error), 10000);
            }
          }
        }
      }

      if (generation !== this.searchGeneration) return;

      const beforeAiFilter = computeMatchPercents(rawHits);

      if (
        this.plugin.isAiActive() &&
        this.plugin.settings.aiFilterIrrelevantResults &&
        beforeAiFilter.length > 0
      ) {
        const exactHits = beforeAiFilter.filter((h) => h.exactMatch);
        const otherHits = beforeAiFilter.filter((h) => !h.exactMatch);

        if (otherHits.length > 0) {
          this.setPhase('ai-filter');
          try {
            const filtered = await this.plugin.aiService.filterRelevantHits(query, otherHits);
            if (generation !== this.searchGeneration) return;
            rawHits =
              filtered.length > 0 ? [...exactHits, ...filtered] : [...exactHits, ...otherHits];
          } catch (error) {
            rawHits = beforeAiFilter;
            if (!this.plugin.settings.aiFallbackToLocal) {
              new Notice(aiErrorNotice(this.plugin.t().searchAiFailed, error), 10000);
            }
          }
        } else {
          rawHits = exactHits;
        }
      } else {
        rawHits = beforeAiFilter;
      }

      if (generation !== this.searchGeneration) return;

      this.applyMatchSplit(rawHits);
      this.callbacks.onHitsChange();
      this.callbacks.onStatusChange();

      const combinedHits = this.allHits();
      if (this.plugin.isAiActive() && combinedHits.length > 0) {
        this.setPhase('ai-article');
        await this.runAiArticle(query, combinedHits, generation);
      }

      if (generation !== this.searchGeneration) return;

      await this.plugin.searchHistory.add(
        createHistoryEntry(
          query,
          scopePath,
          combinedHits,
          this.article,
          this.callbacks.getHistoryArticleSnapshot?.(),
        ),
      );
      this.callbacks.onHistoryChange?.();
    } finally {
      if (generation === this.searchGeneration) {
        this.setSearching(false);
        this.setPhase('idle');
        this.callbacks.onStatusChange();
      }
    }
  }

  moveSelection(delta: number): void {
    const hits = this.allHits();
    if (hits.length === 0) return;
    if (this.selectedIndex < 0) {
      this.selectedIndex = delta > 0 ? 0 : hits.length - 1;
    } else {
      this.selectedIndex = (this.selectedIndex + delta + hits.length) % hits.length;
    }
    this.callbacks.onHitsChange();
  }

  getSelectedHit(): SearchHit | undefined {
    const hits = this.allHits();
    return hits[this.selectedIndex] ?? hits[0];
  }

  private setSearching(searching: boolean): void {
    if (this.isSearching === searching) return;
    this.isSearching = searching;
    this.callbacks.onSearchingChange(searching);
  }

  private setPhase(phase: SearchPhase): void {
    if (this.searchPhase === phase) return;
    this.searchPhase = phase;
    this.callbacks.onStatusChange();
  }

  private async runAiArticle(
    query: string,
    hits: SearchHit[],
    generation: number,
  ): Promise<void> {
    this.callbacks.onArticleChange(null, true);
    try {
      const article = await this.plugin.aiService.optimizeResults(query, hits);
      if (generation !== this.searchGeneration) return;
      this.article = article;
      this.callbacks.onArticleChange(article, false);
    } catch (error) {
      if (generation !== this.searchGeneration) return;
      this.article = null;
      this.callbacks.onArticleChange(null, false);
      new Notice(aiErrorNotice(this.plugin.t().searchAiFailed, error), 10000);
    }
  }
}
