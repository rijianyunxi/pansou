export type ProviderKey = 'quark' | 'baidu';
export interface ProviderPolicy {
  enabled: boolean;
  targetDir: string | null;
  deliveryTtlSeconds: number | null;
  deliveryMinRemainingSeconds: number;
  platformShareDays: number;
}
export interface ProviderForm extends ProviderPolicy { hours: string | number }
export interface DeliveryPolicy { revision: number; quark: ProviderPolicy; baidu: ProviderPolicy }
export interface CheckPolicy { enabled: boolean; validSeconds: number; invalidSeconds: number; intervalSeconds: number; dailyBudget: number }
export function providerForm(value: Partial<ProviderPolicy> = {}): ProviderForm {
  return {
    enabled: false, targetDir: '', deliveryTtlSeconds: null,
    deliveryMinRemainingSeconds: 300, platformShareDays: 7, ...value,
    hours: value.deliveryTtlSeconds == null ? '' : value.deliveryTtlSeconds / 3600,
  };
}
export function providerPayload(value: ProviderForm): ProviderPolicy {
  const { hours, ...policy } = value;
  return { ...policy, targetDir: policy.targetDir?.trim() || null,
    deliveryTtlSeconds: hours === '' ? null : Math.round(Number(hours) * 3600) };
}
export function providerError(key: ProviderKey, value: ProviderForm): string {
  if (!value.enabled) return '';
  const policy = providerPayload(value);
  const dir = policy.targetDir || '';
  if (!selectableDirectory(dir)) return '请选择项目专用目录，不能使用网盘根目录。';
  if (key === 'quark' && !/^[a-zA-Z0-9_-]{1,128}$/.test(dir)) return '夸克目录需为文件夹 fid，也可以点击“选择目录”。';
  if (key === 'baidu' && (!dir.startsWith('/') || dir.length > 1024 || dir.includes('\\') || /[\x00-\x1f\x7f]/.test(dir) || dir.split('/').some(part => part === '.' || part === '..'))) return '百度目录需为完整路径，例如 /pansou。';
  const ttl = policy.deliveryTtlSeconds;
  if (ttl == null || !Number.isFinite(ttl) || ttl < 60 || ttl > 2592000) return '保留时间应在 1 分钟至 30 天之间。';
  if (!Number.isInteger(policy.deliveryMinRemainingSeconds) || policy.deliveryMinRemainingSeconds < 0 || policy.deliveryMinRemainingSeconds >= ttl) return '临期停止交付时间必须小于保留时间。';
  if (![1, 7, 30].includes(policy.platformShareDays)) return '平台分享期限只能为 1、7 或 30 天。';
  return '';
}
export interface CloudFolder { id: string; name: string; path: string; isDir: boolean }
export function folderKey(provider: ProviderKey, folder: CloudFolder): string { return provider === 'quark' ? folder.id : folder.path; }
export function selectableDirectory(value: string): boolean { return Boolean(value.trim()) && value !== '0' && !/^\/+$/u.test(value); }
