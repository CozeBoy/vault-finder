import type { SearchHit } from './types';

export function computeMatchPercents(hits: SearchHit[]): SearchHit[] {
  if (hits.length === 0) return hits;
  const max = Math.max(...hits.map((h) => h.score), 0.001);
  return hits.map((hit) => ({
    ...hit,
    matchPercent: hit.exactMatch
      ? 100
      : Math.min(100, Math.round((hit.score / max) * 100)),
  }));
}

export function splitHitsByThreshold(
  hits: SearchHit[],
  threshold: number,
): { primary: SearchHit[]; weak: SearchHit[] } {
  const scored = hits.every((h) => h.matchPercent !== undefined)
    ? hits
    : computeMatchPercents(hits);
  const exact = scored.filter((h) => h.exactMatch);
  const nonExact = scored.filter((h) => !h.exactMatch);
  const primaryNonExact = nonExact.filter((h) => (h.matchPercent ?? 0) >= threshold);
  const weakNonExact = nonExact.filter((h) => (h.matchPercent ?? 0) < threshold);
  return {
    primary: [...exact, ...primaryNonExact],
    weak: weakNonExact,
  };
}

export function clampMatchThreshold(value: number): number {
  if (Number.isNaN(value)) return 80;
  return Math.max(1, Math.min(100, Math.round(value)));
}
