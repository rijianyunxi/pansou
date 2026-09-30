export type DriveProvider = 'baidu' | 'quark';
export interface DriveFile { id: string; name: string; size: number; isDir: boolean; md5?: string; path?: string }
export interface DriveShare { url: string; password: string; shareId?: string }
export interface DriveResult {
 provider?: DriveProvider; status?: 'valid' | 'invalid' | 'unknown' | 'running' | 'completed' | 'failed' | 'uncertain';
 valid?: boolean; reason?: string; title?: string; fileCount?: number; files?: DriveFile[] | number;
 mode?: 'saved' | 'reused'; count?: number; target?: string; matchedCount?: number; missingCount?: number;
 alreadyExists?: boolean; complete?: boolean; matched?: DriveFile[]; missing?: DriveFile[];
 share?: DriveShare | null; shareError?: string | null; deletedCount?: number; requestKey?: string;
 confirmationToken?: string; warning?: string; expiresIn?: number;
}
