export type CloudType = "baidu" | "quark" | "guangya" | "aliyun" | "uc" | "mobile" | "tianyi" | "115" | "123" | "jianguoyun" | "lanzou" | "xunlei" | "magnet" | "others";
export interface Link { type: CloudType; url: string; password: string | null; }
type LinkValidity = -1 | 0 | 1;
export interface SearchLink { type: CloudType; linkRef: string; linkKey: string; validity?: LinkValidity; checkedAt?: string | null; stale?: boolean; }
export interface ResolvedLink { requestKey: string; status: 'processing' | 'completed' | 'unavailable'; stage?: string; pollAfterMs?: number; deadlineAt?: string; type: CloudType; url?: string; password?: string | null; validity: LinkValidity; originalValidity: LinkValidity; delivery: 'original' | 'reshared' | null; reasonCode?: string; deliveryExpiresAt?: string | null; shareExpiresAt?: string | null; }
export interface SearchResult { resultRef: string; dedupKey: string; refsExpireAt?: string; validity?: LinkValidity; id: string; name: string; description: string | null; datetime: string | null; cloud_types: CloudType[]; links: SearchLink[]; images?: string[]; }
export type SearchResultPayload = Pick<SearchResult, 'resultRef' | 'dedupKey' | 'name'> & { description?: string | null; datetime?: string | null; links: Pick<SearchLink, 'type' | 'linkRef'>[] };
export interface SearchResponse { total: number; results: SearchResultPayload[]; pageSize?: number; hasMore?: boolean; nextCursor?: string | null; searchLogId?: number; searchContext?: string; cloudType?: string | null; }
export interface SearchStreamResultData { results: SearchResultPayload[]; }

export type ManagedResource = Omit<SearchResult, 'links' | 'resultRef' | 'dedupKey' | 'refsExpireAt' | 'validity'> & { links: Link[] };
