# Vault Finder

Fast full-text search for your Obsidian vault, with optional vector retrieval and AI-enhanced keyword expansion, relevance filtering, and result summarization.

[中文说明](README.zh-CN.md)

## Features

- Right-sidebar search panel with keyboard navigation
- Local full-text index (MiniSearch) with automatic incremental updates
- N-gram tokenization for mixed Chinese / English content
- Optional vector search with a separate embeddings API and configurable cache folder
- Match threshold slider, primary vs lower-match result sections, and exact-phrase priority
- Search history tab with past queries and saved summaries
- Right-click on AI summary to save as a note to any nested vault folder
- Optional AI enhancement (OpenAI, Anthropic, Gemini): keyword expansion, relevance filter, Markdown article synthesis
- Chinese / English UI

## Network use

This plugin is **desktop only** and may contact external APIs **only when you configure API keys**.

**Vector search (embeddings)** — requests go to the embeddings URL you set (the default `https://api.aicso.top/v1/embeddings` is an example endpoint; replace it with your own provider). Each request may include truncated note text for indexing or your search query for retrieval. Uses a **separate API key** from AI chat.

**AI chat** — when AI enhancement is enabled, requests go to the chat Base URL you configure (default example: `https://api.aicso.top/`). Sent content is limited to your search query plus paths and truncated snippets of the top N hits — **not full note bodies**.

With AI and vector search disabled, or without API keys configured, the plugin performs local indexing and search only.

## Installation

### From GitHub Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/CozeBoy/vault-finder/releases).
2. Copy them to `.obsidian/plugins/vault-finder/`
3. Enable **Vault Finder** in Obsidian → Settings → Community plugins

### Development

```bash
npm install
npm run dev
```

Symlink or copy the project folder to `.obsidian/plugins/vault-finder/` (folder name must match plugin id).

## Commands

- **Open Vault Finder search** — open the search panel in the right sidebar
- **Rebuild Vault Finder index** — force a full keyword index rebuild

## Settings

See the plugin settings tab for indexing, vector search, AI prompts, cache folders, and advanced options.

## License

MIT — Copyright (c) 2026 CozeBoy
