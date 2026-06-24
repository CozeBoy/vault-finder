# Vault Finder

为 Obsidian 知识库提供快速全文检索，支持可选向量检索与 AI 关键词扩展、相关性筛选和检索综述生成。

[English README](README.md)

## 功能

- 右侧边栏搜索面板，支持键盘操作
- 本地全文索引（MiniSearch），文件变更后自动增量更新
- 中英文混合内容的 n-gram 分词检索
- 可选向量检索：独立 Embeddings API、可配置缓存目录
- 匹配度阈值、主结果 / 低匹配分区、精确短语优先
- 历史搜索标签页，可回看查询与综述
- 检索综述右键保存为笔记，支持选择任意层级子文件夹
- 可选 AI 增强（OpenAI、Anthropic、Gemini）：扩展关键词、过滤无关结果、生成 Markdown 综述
- 中英文界面

## 网络说明

本插件为**仅桌面端**，且**仅在您配置 API Key 后**才会访问外网。

**向量检索（Embeddings）** — 请求发往您设置的 Embeddings URL（默认 `https://api.aicso.top/v1/embeddings` 仅为示例，请改为您自己的服务商）。请求内容可能包含用于建索引的截断笔记文本，或用于检索的搜索词。使用与 AI 对话**独立**的 API Key。

**AI 对话** — 启用 AI 增强后，请求发往您配置的 Base URL（默认示例：`https://api.aicso.top/`）。发送内容包括搜索词及前 N 条命中的路径与截断片段，**不会发送笔记全文**。

关闭 AI / 向量检索，或未配置 API Key 时，仅进行本地索引与搜索，不发起外网请求。

## 安装

### 从 GitHub Release 安装

1. 从 [最新 Release](https://github.com/CozeBoy/vault-finder/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 复制到 `.obsidian/plugins/vault-finder/`
3. 在 Obsidian → 设置 → 社区插件 中启用 **Vault Finder**

### 开发

```bash
npm install
npm run dev
npm run build
```

将项目目录链接或复制到 `.obsidian/plugins/vault-finder/`（文件夹名须与插件 id 一致）。

## 命令

- **打开 Vault Finder 搜索** — 在右侧边栏打开搜索面板
- **重建 Vault Finder 索引** — 强制全量重建关键词索引

## 设置

在插件设置页可配置索引、向量检索、AI 提示词、缓存目录与高级选项。

## 许可证

MIT — Copyright (c) 2026 CozeBoy
