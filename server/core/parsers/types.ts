import type { SearchResult } from "../types/models";

export type ParserInputFormat = "html" | "json" | "text";
/** Manifest format; auto receives the actual format in context and adapts payload/$ accordingly. */
export type ParserPluginFormat = ParserInputFormat | "auto";
export type ParserPluginStatus =
  "draft" | "published" | "disabled" | "archived";
export type ParserPluginTarget = "upstream" | "telegram" | "both";

export interface ParserPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  format: ParserPluginFormat;
  target: ParserPluginTarget;
  timeoutMs: number;
  maxResults: number;
}

export interface ParserPluginVersion {
  version: string;
  code: string;
  manifest: ParserPluginManifest;
  createdAt: string;
  createdBy: string;
  changelog?: string;
}

export interface ParserPluginRecord {
  id: string;
  status: ParserPluginStatus;
  /** Immutable version serving new requests. */
  publishedVersion?: string;
  manifest: ParserPluginManifest;
  code: string;
  versions: ParserPluginVersion[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  lastTestedAt?: string;
  lastTestedVersion?: string;
  lastTestResultCount?: number;
  lastTestError?: string;
}

export interface ParserExecutionContext {
  channel?: string;
  keyword?: string;
  source?: string;
  url?: string;
  page?: number;
  /** Route selected by a source request (for example telegram or jina). */
  route?: string;
  rawBody: string;
  format: ParserInputFormat;
}

export type ParserOutput = Partial<SearchResult> & {
  url?: string;
  type?: string;
  password?: string;
  links?: Array<{ url: string; type?: string; password?: string }>;
};
