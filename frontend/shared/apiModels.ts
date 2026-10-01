export type CloudType = "baidu" | "quark" | "guangya" | "aliyun" | "uc" | "mobile" | "tianyi" | "115" | "123" | "jianguoyun" | "lanzou" | "xunlei" | "magnet" | "others";
export interface Link { type: CloudType; url: string; password: string | null; }
export type LinkValidity = -1 | 0 | 1;
export interface SearchLink { type: CloudType; linkRef: string; linkKey: string; validity: LinkValidity; checkedAt: string | null; stale: boolean; }
export interface ResolvedLink { requestKey: string; status: 'processing' | 'completed' | 'unavailable'; type: CloudType; url?: string; password?: string | null; validity: LinkValidity; originalValidity: LinkValidity; delivery: 'original' | 'reshared' | null; reasonCode?: string; deliveryExpiresAt?: string | null; shareExpiresAt?: string | null; }
export interface SearchResult { resultRef: string; dedupKey: string; refsExpireAt: string; validity: LinkValidity; id: string; name: string; description: string | null; datetime: string | null; cloud_types: CloudType[]; links: SearchLink[]; images?: string[]; }
export interface SearchResponse { total: number; results: SearchResult[]; }
export interface SearchStreamResultData { results: SearchResult[]; }
export interface ProxyNodeMeta { nodeId: string; nodeName: string; attempt: number; status: "success" | "failed"; httpStatus: number | null; elapsedMs: number; error?: string; }
export interface SearchSourceMeta { id: string; name: string; priority: number; status: "success" | "failed" | "skipped"; resultCount: number; elapsedMs: number; transformMs: number | null; proxyNodes: ProxyNodeMeta[]; results?: SearchResult[]; }
export interface SearchExecutionResponse extends SearchResponse { sources?: SearchSourceMeta[]; }

export type ManagedResource = Omit<SearchResult, 'links' | 'resultRef' | 'dedupKey' | 'refsExpireAt' | 'validity'> & { links: Link[]; tags?: string[] };
