import MiniSearch from 'minisearch';
import type { App, TFile } from 'obsidian';
import {
  buildEmbedText,
  contentHash,
  type EmbeddingService,
} from '../ai/embeddings';
import { clampVectorEmbedConcurrency, type VaultFinderSettings } from '../settings';
import { extractSnippet, tokenizeForIndex, tokenizeQuery } from './ngram';
import { computeMatchPercents } from './matchScore';
import type { IndexStatus, SearchHit, SerializedIndex } from './types';
import {
  isInScope,
  isVectorCacheValid,
  VectorIndex,
  type SerializedVectorIndex,
  type VectorEntry,
} from './vectorIndex';
import { KeywordCacheStorage } from './keywordCacheStorage';
import { VectorCacheStorage, stripLegacyPluginCachesFromRecord } from './vectorCacheStorage';

const INDEX_VERSION = 1;
const MODIFY_DEBOUNCE_MS = 500;
const EMBED_BATCH_SIZE = 16;
const EMBED_FAILURE_WAVES_BEFORE_REDUCE = 2;
const EMBED_MAX_FAILURE_WAVES_AT_MIN = 3;

type IndexDoc = { id: string; path: string; title: string; body: string };

export class VaultIndex {
  private miniSearch: MiniSearch<IndexDoc>;
  private docStore = new Map<string, IndexDoc>();
  private vectorIndex = new VectorIndex();
  private modifyTimers = new Map<string, number>();
  private isRebuilding = false;
  private isVectorBuilding = false;
  private lastUpdated: number | null = null;
  private settings: VaultFinderSettings;
  private loadData: () => Promise<unknown>;
  private saveData: (data: unknown) => Promise<void>;
  private persistTimer: number | null = null;
  private vectorPersistTimer: number | null = null;
  private runtimeEmbedConcurrency: number | null = null;
  private consecutiveEmbedFailureWaves = 0;
  private embedFailureWavesAtMinConcurrency = 0;

  constructor(
    private app: App,
    settings: VaultFinderSettings,
    persistence: { loadData: () => Promise<unknown>; saveData: (data: unknown) => Promise<void> },
    private embeddings: EmbeddingService | null,
    private keywordStorage: KeywordCacheStorage,
    private vectorStorage: VectorCacheStorage,
  ) {
    this.settings = settings;
    this.loadData = persistence.loadData;
    this.saveData = persistence.saveData;
    this.miniSearch = this.createMiniSearch();
  }

  updateSettings(settings: VaultFinderSettings): void {
    const prev = this.settings;
    this.settings = settings;

    if (this.vectorCacheKeyChanged(prev)) {
      this.resetEmbedConcurrencyRuntime();
      this.vectorIndex.load(null);
      void this.buildMissingVectors(false);
      return;
    }

    if (prev.vectorEmbedConcurrency !== settings.vectorEmbedConcurrency) {
      this.resetEmbedConcurrencyRuntime();
    }

    if (
      !prev.vectorSearchEnabled &&
      settings.vectorSearchEnabled &&
      this.embeddings?.canEmbed()
    ) {
      void this.buildMissingVectors(false);
    }
  }

  getStatus(): IndexStatus {
    return {
      documentCount: this.miniSearch.documentCount,
      isRebuilding: this.isRebuilding,
      isVectorBuilding: this.isVectorBuilding,
      vectorDocumentCount: this.vectorIndex.size,
      lastUpdated: this.lastUpdated,
    };
  }

  async initialize(): Promise<boolean> {
    const legacyVectorCleaned = await this.loadVectorCache();
    const { cached, legacyKeywordCleaned } = await this.loadKeywordIndex();
    const cacheKey = this.cacheFingerprint();
    if (cached && this.isCacheValid(cached, cacheKey)) {
      try {
        this.miniSearch = MiniSearch.loadJSON<IndexDoc>(cached.miniSearch, {
          fields: ['title', 'path', 'body'],
          storeFields: ['path', 'title', 'body'],
          tokenize: (string) => tokenizeForIndex(string),
        });
        this.rebuildDocStoreFromSearch();
        this.lastUpdated = cached.lastUpdated;
        void this.buildMissingVectors();
        return legacyVectorCleaned || legacyKeywordCleaned;
      } catch {
        // fall through
      }
    }
    await this.rebuildAll();
    return legacyVectorCleaned || legacyKeywordCleaned;
  }

  async rebuildAll(): Promise<void> {
    this.isRebuilding = true;
    try {
      this.miniSearch = this.createMiniSearch();
      this.docStore.clear();
      const files = this.getIndexableFiles();
      for (const file of files) {
        await this.indexFile(file, false, false);
      }
      this.lastUpdated = Date.now();
      await this.flushPersist();
      void this.buildMissingVectors(false);
    } finally {
      this.isRebuilding = false;
    }
  }

  async rebuildVectorIndex(): Promise<void> {
    this.vectorIndex.load(null);
    await this.flushVectorPersist();
    await this.buildMissingVectors(false);
  }

  migrateVectorCacheFolder(prevFolderSetting: string): void {
    const fromDir = this.vectorStorage.resolveDirForSetting(prevFolderSetting);
    const toDir = this.vectorStorage.resolveDir();
    const inMemory = this.vectorIndex.serialize(this.vectorModelKey());
    const hasData = inMemory.entries.length > 0;
    this.vectorStorage.migrate(fromDir, toDir, hasData ? inMemory : null);
  }

  migrateKeywordCacheFolder(prevFolderSetting: string): void {
    const fromDir = this.keywordStorage.resolveDirForSetting(prevFolderSetting);
    const toDir = this.keywordStorage.resolveDir();
    const inMemory = this.serializeKeywordIndex();
    this.keywordStorage.migrate(fromDir, toDir, inMemory);
  }

  search(query: string, scopePath = ''): SearchHit[] {
    return this.mergeHits([query], scopePath, []);
  }

  async searchAsync(queries: string[], scopePath = ''): Promise<SearchHit[]> {
    const primary = queries[0]?.trim() ?? '';
    if (!primary) return [];
    const supplemental = queries.slice(1).map((q) => q.trim()).filter(Boolean);
    return this.searchUserQuery(primary, scopePath, supplemental);
  }

  hasExactContentMatches(query: string, hits: SearchHit[]): boolean {
    if (hits.some((h) => h.exactMatch)) return true;
    const qLower = query.trim().toLowerCase();
    if (!qLower) return false;
    return hits.some(
      (h) =>
        h.title.toLowerCase().includes(qLower) ||
        h.snippet.toLowerCase().includes(qLower) ||
        this.getDocumentBody(h.path).toLowerCase().includes(qLower),
    );
  }

  private async searchUserQuery(
    primaryQuery: string,
    scopePath: string,
    supplementalQueries: string[],
  ): Promise<SearchHit[]> {
    const lists: SearchHit[][] = [this.localSearchForQuery(primaryQuery, scopePath, true)];

    for (const q of supplementalQueries) {
      lists.push(this.localSearchForQuery(q, scopePath, false));
    }

    let merged = this.mergeWithExactPriority(primaryQuery, lists);
    merged = await this.appendVectorHits(primaryQuery, scopePath, merged);
    return computeMatchPercents(merged);
  }

  private localSearchForQuery(
    query: string,
    scopePath: string,
    includeExactTier: boolean,
  ): SearchHit[] {
    const parts: SearchHit[][] = [];
    if (includeExactTier) {
      parts.push(this.exactPhraseSearch(query, scopePath));
    }
    parts.push(this.phraseSearch(query, scopePath));
    parts.push(this.keywordSearch(query, scopePath));
    parts.push(this.substringSearch(query, scopePath));
    return parts.flat();
  }

  private async appendVectorHits(
    primaryQuery: string,
    scopePath: string,
    existing: SearchHit[],
  ): Promise<SearchHit[]> {
    if (!this.embeddings?.canEmbed()) return existing;
    try {
      const queryVector = await this.embeddings.embed(primaryQuery);
      const vectorHits = this.vectorIndex.search(
        queryVector,
        scopePath,
        this.settings.maxResults,
        this.settings.vectorMinScore,
      );
      return this.mergeWithExactPriority(primaryQuery, [existing, vectorHits]);
    } catch {
      return existing;
    }
  }

  searchMultiple(queries: string[], scopePath = ''): SearchHit[] {
    return this.mergeHits(queries, scopePath, []);
  }

  scheduleFileUpdate(file: TFile): void {
    const existing = this.modifyTimers.get(file.path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.modifyTimers.delete(file.path);
      void this.handleFileChange(file);
    }, MODIFY_DEBOUNCE_MS);
    this.modifyTimers.set(file.path, timer);
  }

  removeFile(path: string): void {
    const timer = this.modifyTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      this.modifyTimers.delete(path);
    }
    this.docStore.delete(path);
    this.vectorIndex.remove(path);
    if (this.miniSearch.has(path)) {
      this.miniSearch.discard(path);
      this.lastUpdated = Date.now();
      this.schedulePersist();
      this.scheduleVectorPersist();
    }
  }

  handleRename(file: TFile, oldPath: string): void {
    const doc = this.docStore.get(oldPath);
    this.removeFile(oldPath);
    if (doc) {
      this.vectorIndex.rename(oldPath, file.path, file.basename);
      this.scheduleVectorPersist();
    }
    void this.indexFile(file);
  }

  dispose(): void {
    for (const timer of this.modifyTimers.values()) {
      window.clearTimeout(timer);
    }
    this.modifyTimers.clear();
    if (this.persistTimer) window.clearTimeout(this.persistTimer);
    if (this.vectorPersistTimer) window.clearTimeout(this.vectorPersistTimer);
  }

  settingsFingerprintChanged(prev: VaultFinderSettings): boolean {
    return (
      JSON.stringify(prev.indexableExtensions) !==
        JSON.stringify(this.settings.indexableExtensions) ||
      prev.maxFileSizeBytes !== this.settings.maxFileSizeBytes ||
      JSON.stringify(prev.excludePaths) !== JSON.stringify(this.settings.excludePaths) ||
      JSON.stringify(prev.excludeExtensions) !==
        JSON.stringify(this.settings.excludeExtensions)
    );
  }

  vectorCacheKeyChanged(prev: VaultFinderSettings): boolean {
    return (
      prev.vectorBaseUrl !== this.settings.vectorBaseUrl ||
      prev.embeddingModel !== this.settings.embeddingModel ||
      prev.vectorEmbedMaxChars !== this.settings.vectorEmbedMaxChars
    );
  }

  private mergeHits(queries: string[], scopePath: string, extra: SearchHit[][]): SearchHit[] {
    const primary = queries[0]?.trim() ?? '';
    const lists: SearchHit[][] = [...extra];
    for (const query of queries) {
      lists.push(this.localSearchForQuery(query, scopePath, query === primary));
    }
    return this.mergeWithExactPriority(primary, lists);
  }

  private mergeWithExactPriority(primaryQuery: string, lists: SearchHit[][]): SearchHit[] {
    const qLower = primaryQuery.trim().toLowerCase();
    const exactMap = new Map<string, SearchHit>();
    const restMap = new Map<string, SearchHit>();

    for (const list of lists) {
      for (const hit of list) {
        const body = this.getDocumentBody(hit.path);
        const titleLower = hit.title.toLowerCase();
        const bodyLower = body.toLowerCase();
        const isExact =
          hit.exactMatch === true ||
          (qLower.length > 0 &&
            (titleLower.includes(qLower) ||
              bodyLower.includes(qLower) ||
              hit.path.toLowerCase().includes(qLower)));

        const normalized: SearchHit = isExact
          ? {
              ...hit,
              exactMatch: true,
              score: Math.max(hit.score, titleLower.includes(qLower) ? 200 : 150),
              snippet: extractSnippet(body || hit.snippet, primaryQuery, 120),
            }
          : hit;

        const map = isExact ? exactMap : restMap;
        const existing = map.get(hit.path);
        if (!existing || normalized.score > existing.score) {
          map.set(hit.path, normalized);
        }
      }
    }

    const exact = [...exactMap.values()].sort((a, b) => b.score - a.score);
    const rest = [...restMap.values()]
      .filter((h) => !exactMap.has(h.path))
      .sort((a, b) => b.score - a.score);
    return [...exact, ...rest].slice(0, this.settings.maxResults);
  }

  private mergeHitLists(lists: SearchHit[][]): SearchHit[] {
    return this.mergeWithExactPriority('', lists);
  }

  private getDocumentBody(path: string): string {
    const cached = this.docStore.get(path);
    if (cached?.body) return cached.body;

    const stored = this.miniSearch.getStoredFields(path) as Partial<IndexDoc> | undefined;
    const body = stored?.body ? String(stored.body) : '';
    const title = String(stored?.title ?? path.split('/').pop() ?? path);

    if (body) {
      const doc: IndexDoc = {
        id: path,
        path,
        title: cached?.title ?? title,
        body,
      };
      this.docStore.set(path, doc);
      return body;
    }

    return cached?.body ?? '';
  }

  private forEachIndexedDocument(
    scopePath: string,
    fn: (path: string, title: string, body: string) => void,
  ): void {
    for (const file of this.getIndexableFiles()) {
      if (!this.miniSearch.has(file.path)) continue;
      if (!isInScope(file.path, scopePath)) continue;
      const body = this.getDocumentBody(file.path);
      const stored = this.miniSearch.getStoredFields(file.path) as Partial<IndexDoc> | undefined;
      const title = String(stored?.title ?? file.basename);
      fn(file.path, title, body);
    }
  }

  private exactPhraseSearch(query: string, scopePath: string): SearchHit[] {
    const q = query.trim();
    if (!q) return [];

    const qLower = q.toLowerCase();
    const hits: SearchHit[] = [];

    this.forEachIndexedDocument(scopePath, (path, title, body) => {
      const titleLower = title.toLowerCase();
      const bodyLower = body.toLowerCase();
      let score = 0;
      if (titleLower.includes(qLower)) score = 200;
      else if (bodyLower.includes(qLower)) score = 150;
      if (score === 0) return;

      hits.push({
        path,
        title,
        snippet: extractSnippet(body, query, 120),
        score,
        exactMatch: true,
      });
    });

    return hits.sort((a, b) => b.score - a.score);
  }

  private keywordSearch(query: string, scopePath: string): SearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const terms = tokenizeQuery(trimmed);
    const searchQuery = terms.length > 0 ? terms.join(' ') : trimmed.toLowerCase();
    const snippetLen = 120;

    let raw = this.miniSearch.search(searchQuery, { combineWith: 'AND', prefix: true });
    if (raw.length === 0 || this.prefersOrSearch(trimmed)) {
      const orHits = this.miniSearch.search(searchQuery, { combineWith: 'OR', prefix: true });
      raw = raw.length === 0 ? orHits : this.mergeRawHits(raw, orHits);
    } else if (raw.length < 3) {
      const orHits = this.miniSearch.search(searchQuery, { combineWith: 'OR', prefix: true });
      raw = this.mergeRawHits(raw, orHits);
    }

    return raw
      .map((hit) => this.toSearchHit(hit, trimmed, snippetLen))
      .filter((hit) => isInScope(hit.path, scopePath));
  }

  private prefersOrSearch(query: string): boolean {
    return query.length <= 12 && /[\u4e00-\u9fff]/.test(query);
  }

  private phraseSearch(query: string, scopePath: string): SearchHit[] {
    const q = query.trim();
    if (!q) return [];

    const qLower = q.toLowerCase();
    const hits: SearchHit[] = [];

    this.forEachIndexedDocument(scopePath, (path, title, body) => {
      const titleLower = title.toLowerCase();
      const bodyLower = body.toLowerCase();

      let score = 0;
      if (titleLower.includes(qLower)) score += 25;
      if (bodyLower.includes(qLower)) score += 18;
      if (score === 0) return;

      hits.push({
        path,
        title,
        snippet: extractSnippet(body, query, 120),
        score,
      });
    });

    return hits.sort((a, b) => b.score - a.score);
  }

  private substringSearch(query: string, scopePath: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    const minLen = /[\u4e00-\u9fff]/.test(q) ? 1 : 2;
    if (q.length < minLen) return [];

    const hits: SearchHit[] = [];
    this.forEachIndexedDocument(scopePath, (path, title, body) => {
      const titleLower = title.toLowerCase();
      const bodyLower = body.toLowerCase();
      const pathLower = path.toLowerCase();

      let score = 0;
      if (titleLower.includes(q)) score += 5;
      if (bodyLower.includes(q)) score += 3;
      if (pathLower.includes(q)) score += 2;
      if (score === 0) return;

      hits.push({
        path,
        title,
        snippet: extractSnippet(body, query, 120),
        score,
      });
    });

    return hits.sort((a, b) => b.score - a.score);
  }

  private toSearchHit(
    hit: { path?: unknown; id?: unknown; title?: unknown; body?: unknown; score: number },
    query: string,
    snippetLen: number,
  ): SearchHit {
    const path = String(hit.path ?? hit.id);
    const title = String(hit.title ?? path.split('/').pop() ?? path);
    const body = String(hit.body ?? this.docStore.get(path)?.body ?? '');
    return {
      path,
      title,
      snippet: extractSnippet(body, query, snippetLen),
      score: hit.score,
    };
  }

  private mergeRawHits<T extends { id: unknown; score: number }>(a: T[], b: T[]): T[] {
    const map = new Map<string, T>();
    for (const hit of [...a, ...b]) {
      const id = String(hit.id);
      const existing = map.get(id);
      if (!existing || hit.score > existing.score) map.set(id, hit);
    }
    return [...map.values()].sort((x, y) => y.score - x.score);
  }

  private createMiniSearch(): MiniSearch<IndexDoc> {
    return new MiniSearch({
      idField: 'id',
      fields: ['title', 'path', 'body'],
      storeFields: ['path', 'title', 'body'],
      tokenize: (string) => tokenizeForIndex(string),
    });
  }

  private rebuildDocStoreFromSearch(): void {
    this.docStore.clear();
    for (const file of this.getIndexableFiles()) {
      if (!this.miniSearch.has(file.path)) continue;
      const stored = this.miniSearch.getStoredFields(file.path) as Partial<IndexDoc> | undefined;
      if (!stored?.path) continue;
      this.docStore.set(file.path, {
        id: stored.path,
        path: stored.path,
        title: String(stored.title ?? file.basename),
        body: String(stored.body ?? ''),
      });
    }
    // Warm body cache from MiniSearch stored fields for any doc missing body text.
    for (const file of this.getIndexableFiles()) {
      if (this.miniSearch.has(file.path)) {
        this.getDocumentBody(file.path);
      }
    }
  }

  private async handleFileChange(file: TFile): Promise<void> {
    if (!this.shouldIndexFile(file)) {
      this.removeFile(file.path);
      return;
    }
    await this.indexFile(file);
  }

  private async indexFile(
    file: TFile,
    persist = true,
    embedVector = true,
  ): Promise<void> {
    if (!this.shouldIndexFile(file)) return;

    try {
      const body = await this.app.vault.cachedRead(file);
      const doc: IndexDoc = {
        id: file.path,
        path: file.path,
        title: file.basename,
        body,
      };
      this.docStore.set(file.path, doc);
      if (this.miniSearch.has(file.path)) {
        this.miniSearch.replace(doc);
      } else {
        this.miniSearch.add(doc);
      }
      this.lastUpdated = Date.now();
      if (persist) this.schedulePersist();
      if (embedVector) void this.embedDocVector(doc);
    } catch {
      // skip unreadable files
    }
  }

  private async embedDocVector(doc: IndexDoc): Promise<void> {
    if (!this.embeddings?.canEmbed()) return;

    const embedText = buildEmbedText(doc.title, doc.body, this.settings.vectorEmbedMaxChars);
    const hash = contentHash(embedText);
    if (this.vectorIndex.getContentHash(doc.path) === hash) return;

    try {
      const vector = await this.embeddings.embed(embedText);
      const entry: VectorEntry = {
        path: doc.path,
        title: doc.title,
        contentHash: hash,
        vector,
        preview: extractSnippet(doc.body, doc.title, 120),
      };
      this.vectorIndex.upsert(entry);
      this.scheduleVectorPersist();
    } catch {
      // skip failed embedding
    }
  }

  private async buildMissingVectors(force = false): Promise<void> {
    if (!this.embeddings?.canEmbed()) return;

    const pending: IndexDoc[] = [];
    for (const doc of this.docStore.values()) {
      const embedText = buildEmbedText(doc.title, doc.body, this.settings.vectorEmbedMaxChars);
      const hash = contentHash(embedText);
      if (!force && this.vectorIndex.getContentHash(doc.path) === hash) continue;
      pending.push(doc);
    }

    if (pending.length === 0) return;

    this.resetEmbedConcurrencyRuntime();
    const batches: IndexDoc[][] = [];
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      batches.push(pending.slice(i, i + EMBED_BATCH_SIZE));
    }

    this.isVectorBuilding = true;
    try {
      const queue = [...batches];
      while (queue.length > 0) {
        const concurrency = this.getEffectiveEmbedConcurrency();
        const wave = queue.splice(0, concurrency);
        const failed: IndexDoc[][] = [];
        const results = await Promise.all(
          wave.map(async (batch) => {
            try {
              await this.processEmbedBatch(batch);
              return true;
            } catch {
              failed.push(batch);
              return false;
            }
          }),
        );
        const failCount = results.filter((ok) => !ok).length;
        if (failCount === wave.length) {
          this.recordEmbedFailureWave(failCount);
          if (
            this.getEffectiveEmbedConcurrency() === 1 &&
            this.embedFailureWavesAtMinConcurrency >= EMBED_MAX_FAILURE_WAVES_AT_MIN
          ) {
            break;
          }
          queue.unshift(...failed);
          await this.embedBackoffDelay();
        } else if (failCount > 0) {
          this.recordEmbedFailureWave(failCount);
          queue.unshift(...failed);
        } else {
          this.recordEmbedSuccess();
        }
      }
    } finally {
      this.isVectorBuilding = false;
    }
  }

  private async processEmbedBatch(batch: IndexDoc[]): Promise<void> {
    if (!this.embeddings?.canEmbed()) return;

    const texts = batch.map((doc) =>
      buildEmbedText(doc.title, doc.body, this.settings.vectorEmbedMaxChars),
    );
    const vectors = await this.embeddings.embedBatch(texts);
    batch.forEach((doc, idx) => {
      const vector = vectors[idx];
      if (!vector || vector.length === 0) return;
      const embedText = texts[idx] ?? '';
      this.vectorIndex.upsert({
        path: doc.path,
        title: doc.title,
        contentHash: contentHash(embedText),
        vector,
        preview: extractSnippet(doc.body, doc.title, 120),
      });
    });
    await this.flushVectorPersist();
  }

  private resetEmbedConcurrencyRuntime(): void {
    this.runtimeEmbedConcurrency = null;
    this.consecutiveEmbedFailureWaves = 0;
    this.embedFailureWavesAtMinConcurrency = 0;
  }

  private getEffectiveEmbedConcurrency(): number {
    const configured = clampVectorEmbedConcurrency(this.settings.vectorEmbedConcurrency);
    if (this.runtimeEmbedConcurrency === null) return configured;
    return Math.max(1, Math.min(configured, this.runtimeEmbedConcurrency));
  }

  private recordEmbedFailureWave(failedCount: number): void {
    this.consecutiveEmbedFailureWaves++;
    const current = this.getEffectiveEmbedConcurrency();
    if (
      this.consecutiveEmbedFailureWaves >= EMBED_FAILURE_WAVES_BEFORE_REDUCE ||
      failedCount >= current
    ) {
      this.runtimeEmbedConcurrency = Math.max(1, Math.floor(current / 2));
      this.consecutiveEmbedFailureWaves = 0;
    }
    if (this.getEffectiveEmbedConcurrency() === 1) {
      this.embedFailureWavesAtMinConcurrency++;
    }
  }

  private recordEmbedSuccess(): void {
    this.consecutiveEmbedFailureWaves = 0;
    this.embedFailureWavesAtMinConcurrency = 0;
    const configured = clampVectorEmbedConcurrency(this.settings.vectorEmbedConcurrency);
    const current = this.getEffectiveEmbedConcurrency();
    if (current < configured) {
      this.runtimeEmbedConcurrency = Math.min(configured, current + 1);
    }
  }

  private async embedBackoffDelay(): Promise<void> {
    const configured = clampVectorEmbedConcurrency(this.settings.vectorEmbedConcurrency);
    const current = this.getEffectiveEmbedConcurrency();
    if (current >= configured) return;
    const ms = Math.min(10000, Math.round((1000 * configured) / current));
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private getIndexableFiles(): TFile[] {
    return this.app.vault.getFiles().filter((file) => this.shouldIndexFile(file));
  }

  private shouldIndexFile(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    if (!this.settings.indexableExtensions.includes(ext)) return false;
    if (this.settings.excludeExtensions.includes(ext)) return false;
    if (file.stat.size > this.settings.maxFileSizeBytes) return false;
    if (file.path.startsWith(`${this.app.vault.configDir}/`)) return false;
    for (const prefix of this.settings.excludePaths) {
      const trimmed = prefix.trim();
      if (trimmed && file.path.startsWith(trimmed)) return false;
    }
    return true;
  }

  private cacheFingerprint(): string {
    return JSON.stringify({
      extensions: this.settings.indexableExtensions,
      maxFileSize: this.settings.maxFileSizeBytes,
      exclude: this.settings.excludePaths,
      excludeExtensions: this.settings.excludeExtensions,
    });
  }

  private vectorModelKey(): string {
    return `${this.settings.vectorBaseUrl}|${this.settings.embeddingModel}|${this.settings.vectorEmbedMaxChars}`;
  }

  private isCacheValid(cached: SerializedIndex, fingerprint: string): boolean {
    return cached.version === INDEX_VERSION && cached.extensionsKey === fingerprint;
  }

  private async loadKeywordIndex(): Promise<{
    cached: SerializedIndex | null;
    legacyKeywordCleaned: boolean;
  }> {
    let serialized = this.keywordStorage.load();
    const legacy = await this.loadLegacyKeywordCacheFromData();

    if (!serialized && legacy) {
      serialized = legacy;
      this.keywordStorage.save(serialized);
    }

    let legacyKeywordCleaned = false;
    if (legacy) {
      await this.clearLegacyKeywordCacheFromData();
      legacyKeywordCleaned = true;
    }

    return { cached: serialized, legacyKeywordCleaned };
  }

  private serializeKeywordIndex(): SerializedIndex {
    return {
      version: INDEX_VERSION,
      extensionsKey: this.cacheFingerprint(),
      maxFileSize: this.settings.maxFileSizeBytes,
      excludeKey: JSON.stringify(this.settings.excludePaths),
      miniSearch: JSON.stringify(this.miniSearch.toJSON()),
      lastUpdated: this.lastUpdated ?? Date.now(),
    };
  }

  private async loadLegacyKeywordCacheFromData(): Promise<SerializedIndex | null> {
    const data: unknown = await this.loadData();
    if (typeof data !== 'object' || data === null) return null;
    const index = (data as Record<string, unknown>).indexCache;
    if (typeof index !== 'object' || index === null) return null;
    return index as SerializedIndex;
  }

  private async clearLegacyKeywordCacheFromData(): Promise<void> {
    const data: unknown = await this.loadData();
    if (typeof data !== 'object' || data === null) return;
    const record = data as Record<string, unknown>;
    if (!('indexCache' in record)) return;
    await this.saveData(stripLegacyPluginCachesFromRecord(record));
  }

  private async loadVectorCache(): Promise<boolean> {
    let serialized = this.vectorStorage.load();
    const legacy = await this.loadLegacyVectorCacheFromData();

    if (!serialized && legacy) {
      serialized = legacy;
      this.vectorStorage.save(serialized);
    }

    let legacyCleaned = false;
    if (legacy) {
      await this.clearLegacyVectorCacheFromData();
      legacyCleaned = true;
    }

    if (serialized && isVectorCacheValid(serialized, this.vectorModelKey())) {
      this.vectorIndex.load(serialized);
    }
    return legacyCleaned;
  }

  async purgeLegacyVectorCacheFromData(): Promise<boolean> {
    const legacy = await this.loadLegacyVectorCacheFromData();
    if (!legacy) return false;
    if (!this.vectorStorage.load()) {
      this.vectorStorage.save(legacy);
    }
    await this.clearLegacyVectorCacheFromData();
    return true;
  }

  private async loadLegacyVectorCacheFromData(): Promise<SerializedVectorIndex | null> {
    const data: unknown = await this.loadData();
    if (typeof data !== 'object' || data === null) return null;
    const cache = (data as Record<string, unknown>).vectorCache;
    if (typeof cache !== 'object' || cache === null) return null;
    return cache as SerializedVectorIndex;
  }

  private async clearLegacyVectorCacheFromData(): Promise<void> {
    const data: unknown = await this.loadData();
    if (typeof data !== 'object' || data === null) return;
    const record = data as Record<string, unknown>;
    if (!('vectorCache' in record)) return;
    await this.saveData(stripLegacyPluginCachesFromRecord(record));
  }

  private schedulePersist(): void {
    if (this.persistTimer) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersist();
    }, 1000);
  }

  private scheduleVectorPersist(): void {
    if (this.vectorPersistTimer) window.clearTimeout(this.vectorPersistTimer);
    this.vectorPersistTimer = window.setTimeout(() => {
      this.vectorPersistTimer = null;
      void this.flushVectorPersist();
    }, 2000);
  }

  private async flushPersist(): Promise<void> {
    this.keywordStorage.save(this.serializeKeywordIndex());
  }

  private async flushVectorPersist(): Promise<void> {
    this.vectorStorage.save(this.vectorIndex.serialize(this.vectorModelKey()));
  }
}
