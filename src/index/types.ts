export interface IndexedDocument {
  id: string;
  path: string;
  title: string;
  body: string;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  matchPercent?: number;
  /** Document contains the query as an exact phrase in title or body */
  exactMatch?: boolean;
}

export interface IndexStatus {
  documentCount: number;
  isRebuilding: boolean;
  isVectorBuilding: boolean;
  vectorDocumentCount: number;
  lastUpdated: number | null;
}

export interface SerializedIndex {
  version: number;
  extensionsKey: string;
  maxFileSize: number;
  excludeKey: string;
  miniSearch: string;
  lastUpdated: number;
}
