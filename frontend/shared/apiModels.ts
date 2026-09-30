export type CloudType = "baidu" | "quark" | "guangya" | "aliyun" | "uc" | "mobile" | "tianyi" | "115" | "123" | "jianguoyun" | "lanzou" | "xunlei" | "magnet" | "others";
export interface Link { type: CloudType; url: string; password: string | null; }
export interface SearchResult { id: string; name: string; description: string | null; datetime: string | null; cloud_types: CloudType[]; links: Link[]; tags?: string[]; images?: string[]; }
export interface SearchResponse { total: number; results: SearchResult[]; }
export interface SearchStreamResultData { results: SearchResult[]; }
export interface ProxyNodeMeta { nodeId: string; nodeName: string; attempt: number; status: "success" | "failed"; httpStatus: number | null; elapsedMs: number; error?: string; }
export interface SearchSourceMeta { id: string; name: string; priority: number; status: "success" | "failed" | "skipped"; resultCount: number; elapsedMs: number; transformMs: number | null; proxyNodes: ProxyNodeMeta[]; results?: SearchResult[]; }
export interface SearchExecutionResponse extends SearchResponse { sources?: SearchSourceMeta[]; }
