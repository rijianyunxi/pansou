export const DELIVERY_PROVIDERS = [{ key: 'quark', name: '夸克网盘' }, { key: 'baidu', name: '百度网盘' }, { key: 'aliyun', name: '阿里云盘' }, { key: 'xunlei', name: '迅雷云盘' }, { key: 'guangya', name: '光鸭网盘' }] as const;
export type ProviderKey = typeof DELIVERY_PROVIDERS[number]['key'];
export function providerRecord<T>(factory: () => T): Record<ProviderKey, T> { return Object.fromEntries(DELIVERY_PROVIDERS.map(p => [p.key, factory()])) as Record<ProviderKey, T>; }
export function providerName(key: ProviderKey): string { return DELIVERY_PROVIDERS.find(p => p.key === key)?.name || key; }
/**
 * One netdisk's full server-side configuration: the on-demand transfer switch and
 * parameters, plus the background validity-check parameters. Mirrors the
 * `cloud_provider_policies` row (one row per provider) returned by the API.
 */
export interface ProviderPolicy {
  provider: ProviderKey;
  enabled: boolean;
  targetDir: string | null;
  targetDirName: string;
  retentionSeconds: number | null;
  deliveryMinRemainingSeconds: number;
  platformShareDays: number;
  checkIntervalSeconds: number;
  checkValidSeconds: number;
  checkInvalidSeconds: number;
  checkDailyBudget: number;
  revision: number;
}
export interface ProviderForm extends ProviderPolicy { hours: string | number }
export function providerForm(value: Partial<ProviderPolicy> = {}): ProviderForm {
  return {
    provider: 'quark', enabled: false, targetDir: null, targetDirName: '',
    retentionSeconds: null, deliveryMinRemainingSeconds: 300, platformShareDays: 7,
    checkIntervalSeconds: 2, checkValidSeconds: 86400, checkInvalidSeconds: 604800,
    checkDailyBudget: 1000, revision: 1, ...value,
    hours: value.retentionSeconds == null ? '' : value.retentionSeconds / 3600,
  };
}
export function providerPayload(value: ProviderForm): ProviderPolicy {
  const { hours, ...policy } = value;
  return { ...policy, targetDir: policy.targetDir?.trim() || null,
    retentionSeconds: hours === '' ? null : Math.round(Number(hours) * 3600) };
}
export function providerError(key: ProviderKey, value: ProviderForm): string {
  const policy = providerPayload(value);
  if (policy.enabled) {
    const dir = policy.targetDir || '';
    if (!selectableDirectory(dir)) return '请选择项目专用目录，不能使用网盘根目录。';
    if (key === 'quark' && !/^[a-zA-Z0-9_-]{1,128}$/.test(dir)) return '夸克目录需为文件夹 fid，也可以点击“选择目录”。';
    if (key !== 'quark' && key !== 'baidu' && !/^[a-zA-Z0-9_-]{1,128}$/.test(dir)) return '目录需为文件夹 ID，也可以点击“选择目录”。';
    if (key === 'baidu' && (!dir.startsWith('/') || dir.length > 1024 || dir.includes('\\') || /[\x00-\x1f\x7f]/.test(dir) || dir.split('/').some(part => part === '.' || part === '..'))) return '百度目录需为完整路径，例如 /pansou。';
    const ttl = policy.retentionSeconds;
    if (ttl == null || !Number.isFinite(ttl) || ttl < 60 || ttl > 2592000) return '清理时间应在 1 分钟至 30 天之间。';
    if (!Number.isInteger(policy.deliveryMinRemainingSeconds) || policy.deliveryMinRemainingSeconds < 0 || policy.deliveryMinRemainingSeconds >= ttl) return '临期停止交付时间必须小于清理时间。';
    if (![1, 7, 30].includes(policy.platformShareDays)) return '平台分享期限只能为 1、7 或 30 天。';
  }
  if (!Number.isInteger(policy.checkIntervalSeconds) || policy.checkIntervalSeconds < 2 || policy.checkIntervalSeconds > 3600) return '检测间隔应在 2 秒至 1 小时之间。';
  if (!Number.isInteger(policy.checkValidSeconds) || policy.checkValidSeconds < 60 || policy.checkValidSeconds > 2592000) return '有效结果缓存应在 1 分钟至 30 天之间。';
  if (!Number.isInteger(policy.checkInvalidSeconds) || policy.checkInvalidSeconds < 60 || policy.checkInvalidSeconds > 2592000) return '失效结果缓存应在 1 分钟至 30 天之间。';
  if (!Number.isInteger(policy.checkDailyBudget) || policy.checkDailyBudget < 1 || policy.checkDailyBudget > 100000) return '每个平台每日检测上限应在 1 至 100000 之间。';
  return '';
}
export function durationLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '未设置';
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}
export function directoryLabel(policy: Pick<ProviderPolicy, 'provider' | 'targetDir' | 'targetDirName'>): string {
  if (!policy.targetDir) return '未选择';
  if (policy.targetDirName) return policy.targetDirName;
  return policy.provider === 'baidu' ? policy.targetDir : '已配置项目专用目录';
}
export interface CloudFolder { id: string; name: string; path: string; isDir: boolean }
export function folderKey(provider: ProviderKey, folder: CloudFolder): string { return provider === 'baidu' ? folder.path : folder.id; }
export function providerRoot(provider: ProviderKey): string { return provider === 'baidu' ? '/' : provider === 'aliyun' ? 'root' : '0'; }
export function selectableDirectory(value: string): boolean { const dir = value.trim(); return Boolean(dir) && dir !== '0' && dir !== 'root' && !/^\/+$/u.test(dir); }
