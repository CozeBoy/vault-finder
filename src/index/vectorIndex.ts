import { cosineSimilarity } from '../ai/embeddings';
import type { SearchHit } from './types';

export interface VectorEntry {
  path: string;
  title: string;
  contentHash: string;
  vector: number[];
  preview: string;
}

export interface SerializedVectorIndex {
  version: number;
  modelKey: string;
  entries: VectorEntry[];
}

const VECTOR_INDEX_VERSION = 1;

export class VectorIndex {
  private entries = new Map<string, VectorEntry>();

  get size(): number {
    return this.entries.size;
  }

  load(serialized: SerializedVectorIndex | null): void {
    this.entries.clear();
    if (!serialized) return;
    for (const entry of serialized.entries) {
      if (entry.path && entry.vector.length > 0) {
        this.entries.set(entry.path, entry);
      }
    }
  }

  serialize(modelKey: string): SerializedVectorIndex {
    return {
      version: VECTOR_INDEX_VERSION,
      modelKey,
      entries: [...this.entries.values()],
    };
  }

  upsert(entry: VectorEntry): void {
    this.entries.set(entry.path, entry);
  }

  remove(path: string): void {
    this.entries.delete(path);
  }

  rename(oldPath: string, newPath: string, newTitle: string): void {
    const existing = this.entries.get(oldPath);
    if (!existing) return;
    this.entries.delete(oldPath);
    this.entries.set(newPath, { ...existing, path: newPath, title: newTitle });
  }

  getContentHash(path: string): string | undefined {
    return this.entries.get(path)?.contentHash;
  }

  search(
    queryVector: number[],
    scopePath: string,
    limit: number,
    minScore = 0.25,
  ): SearchHit[] {
    const hits: SearchHit[] = [];

    for (const entry of this.entries.values()) {
      if (!isInScope(entry.path, scopePath)) continue;
      const score = cosineSimilarity(queryVector, entry.vector);
      if (score < minScore) continue;
      hits.push({
        path: entry.path,
        title: entry.title,
        snippet: entry.preview,
        score: score * 10,
      });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function isInScope(path: string, scopePath: string): boolean {
  const scope = scopePath.trim().replace(/\/+$/, '');
  if (!scope) return true;
  return path === scope || path.startsWith(`${scope}/`);
}

export function isVectorCacheValid(
  cached: SerializedVectorIndex | null,
  modelKey: string,
): boolean {
  return cached !== null && cached.version === VECTOR_INDEX_VERSION && cached.modelKey === modelKey;
}
