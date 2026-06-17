import { requestUrl } from 'obsidian';
import type { VaultFinderSettings } from '../settings';
import { hasValidVectorKey } from '../settings';

export class EmbeddingService {
  constructor(private getSettings: () => VaultFinderSettings) {}

  canEmbed(): boolean {
    const s = this.getSettings();
    return s.vectorSearchEnabled && hasValidVectorKey(s);
  }

  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedBatch([text]);
    const first = vectors[0];
    if (!first) throw new Error('Empty embedding response');
    return first;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const settings = this.getSettings();
    const url = resolveEmbeddingsUrl(settings.vectorBaseUrl);
    const timeout = settings.vectorTimeoutMs;

    const res = await requestWithTimeout(
      {
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.vectorApiKey}`,
        },
        body: JSON.stringify({
          model: settings.embeddingModel,
          input: texts,
        }),
        throw: false,
      },
      timeout,
    );

    if (res.status >= 400) {
      throw new Error(`Embedding error ${res.status}: ${res.text}`);
    }

    return extractEmbeddings(res.json);
  }
}

export function resolveEmbeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/embeddings')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readEmbeddingIndex(item: unknown): number {
  if (typeof item !== 'object' || item === null || !('index' in item)) return 0;
  const index = (item as { index?: unknown }).index;
  return typeof index === 'number' ? index : 0;
}

function readEmbeddingVector(item: unknown): number[] {
  if (typeof item !== 'object' || item === null || !('embedding' in item)) return [];
  const embedding = (item as { embedding?: unknown }).embedding;
  if (!isUnknownArray(embedding)) return [];
  return embedding.filter((v): v is number => typeof v === 'number');
}

function extractEmbeddings(json: unknown): number[][] {
  if (typeof json !== 'object' || json === null) return [];
  const rawData = (json as { data?: unknown }).data;
  if (!isUnknownArray(rawData)) return [];

  const sorted = [...rawData].sort(
    (a, b) => readEmbeddingIndex(a) - readEmbeddingIndex(b),
  );

  return sorted.map(readEmbeddingVector);
}

async function requestWithTimeout(
  params: Parameters<typeof requestUrl>[0],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof requestUrl>>> {
  if (timeoutMs <= 0) return requestUrl(params);

  let timer: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('Embedding request timeout')), timeoutMs);
  });

  try {
    return await Promise.race([requestUrl(params), timeoutPromise]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export function contentHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function buildEmbedText(title: string, body: string, maxChars: number): string {
  const trimmed = body.slice(0, maxChars);
  return `${title}\n\n${trimmed}`;
}
