import type { RequestUrlResponse } from 'obsidian';

export interface ParsedRequestResponse {
  json: unknown;
  text: string;
}

/** Normalize requestUrl output — json may be missing while text still holds JSON. */
export function parseRequestResponse(res: RequestUrlResponse): ParsedRequestResponse {
  const text = typeof res.text === 'string' ? res.text : '';
  if (res.json !== undefined && res.json !== null) {
    return { json: res.json, text };
  }
  if (!text.trim()) {
    return { json: null, text };
  }
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    return { json: null, text };
  }
}
