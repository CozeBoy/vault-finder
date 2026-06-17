/** Character bigram n-gram tokenizer for mixed CJK / Latin text. */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const LATIN_WORD_RE = /[a-z0-9]+/gi;

export function tokenizeForIndex(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();

  let cjkRun = '';
  for (const char of lower) {
    if (CJK_RE.test(char)) {
      cjkRun += char;
    } else {
      if (cjkRun.length > 0) {
        addCjkTokens(cjkRun, tokens);
        cjkRun = '';
      }
    }
  }
  if (cjkRun.length > 0) {
    addCjkTokens(cjkRun, tokens);
  }

  const latinMatches = lower.match(LATIN_WORD_RE);
  if (latinMatches) {
    for (const word of latinMatches) {
      tokens.add(word);
      addLatinBigrams(word, tokens);
    }
  }

  return [...tokens];
}

function addCjkTokens(run: string, tokens: Set<string>): void {
  if (run.length === 1) {
    tokens.add(run);
    return;
  }
  for (let i = 0; i < run.length - 1; i++) {
    tokens.add(run.slice(i, i + 2));
  }
  tokens.add(run);
}

function addLatinBigrams(word: string, tokens: Set<string>): void {
  if (word.length < 2) return;
  for (let i = 0; i < word.length - 1; i++) {
    tokens.add(word.slice(i, i + 2));
  }
}

export function tokenizeQuery(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  return tokenizeForIndex(trimmed);
}

export function extractSnippet(content: string, query: string, maxLen: number): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.trim().toLowerCase();
  let index = lowerContent.indexOf(lowerQuery);

  if (index < 0) {
    const tokens = tokenizeQuery(query);
    for (const token of tokens) {
      index = lowerContent.indexOf(token);
      if (index >= 0) break;
    }
  }

  if (index < 0) {
    const snippet = content.slice(0, maxLen);
    return content.length > maxLen ? `${snippet}…` : snippet;
  }

  const half = Math.floor(maxLen / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(content.length, start + maxLen);
  let snippet = content.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < content.length) snippet = `${snippet}…`;
  return snippet;
}
