/** Remove Obsidian wikilink citations from markdown (e.g. [[path/to/note]]). */
export function stripSourceWikilinks(markdown: string): string {
  return markdown
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function copyTextForArticle(markdown: string, includeSources: boolean): string {
  const trimmed = markdown.trim();
  if (!trimmed) return '';
  return includeSources ? trimmed : stripSourceWikilinks(trimmed);
}
