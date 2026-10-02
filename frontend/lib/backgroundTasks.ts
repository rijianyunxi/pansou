export const TASK_KINDS = [
  { key: 'sync', name: '关联同步', hint: '事务队列中的待同步资源；成功后出队，不保留逐资源成功历史。后台自动处理，无需重复提交。', statuses: ['all','queued'] },
  { key: 'checks', name: '有效性检测', hint: '有效性显示链接当前观测，不是每次任务的历史快照；检测完成不代表链接有效。重检仍受账号、频率、额度和熔断策略限制。', statuses: ['all','attention','queued','running','completed','failed'] },
  { key: 'resolve', name: '取链 / 转存', hint: '用户点击触发的取链记录。超时返回原链接不一定代表失败；不能在后台重放用户授权或重复转存。', statuses: ['all','attention','queued','running','completed','failed'] },
  { key: 'cleanup', name: '链接清理', hint: '管理到期或取链超时产生的云端产物。', statuses: ['all','attention','queued','running','completed','failed','blocked'] },
  { key: 'maintenance', name: '维护与异常', hint: '记录状态过期、超时恢复等维护批次及其他链接通道异常，保留 7 天。从本次升级开始记录；成功批次不等于处理了资源。', statuses: ['all','attention','completed','failed'] },
] as const;
export type TaskKind = typeof TASK_KINDS[number]['key'];
export interface BackgroundTask {
  id: string; title: string; kind: string; status: string; createdAt: string; updatedAt: string;
  provider?: string; attempts?: number; runAfter?: string; leaseUntil?: string; deadlineAt?: string;
  errorCode?: string; reasonCode?: string; delivery?: string; resultKind?: string; cacheHit?: boolean;
  validity?: number; failureCount?: number; durationMs?: number; originalUrl?: string;
  pages?: number; messages?: number; resources?: number; revision?: number; httpStatus?: number;
  checkedAt?: string; lastAttemptAt?: string;
  canRetry: boolean; canCancel: boolean;
}
const providers = ['baidu','quark','aliyun','xunlei','guangya'];
export function taskFilters(q: Record<string, unknown>) {
  const config = TASK_KINDS.find(c => c.key === q.kind) || TASK_KINDS[0];
  const status = typeof q.status === 'string' && (config.statuses as readonly string[]).includes(q.status) ? q.status : 'all';
  const provider = ['checks','resolve','cleanup'].includes(config.key) && typeof q.provider === 'string' && providers.includes(q.provider) ? q.provider : '';
  const before = typeof q.before === 'string' && q.before.length <= 2048 ? q.before : '';
  return { kind: config.key, status, provider, before };
}
const labels: Record<string,string> = {
  all:'全部任务', attention:'需要关注', queued:'排队中', running:'执行中', completed:'已完成',
  failed:'失败', paused:'已暂停', cancelled:'已取消', blocked:'已阻塞', uncertain:'结果待核实',
  original:'原链接检测', reshared:'转存分享',
  resolve:'按需取链', save:'转存', existing:'复用', delete:'删除',
  'link-sync':'关联同步', 'link-check':'有效性检测', 'link-cleanup':'链接清理', 'link-maintenance':'状态过期 / 超时维护',
};
export function taskLabel(key?: string) { return key ? labels[key] || key : '未记录'; }
const reasons: Record<string,string> = {
  deadline_exceeded:'取链超过 5 秒，已回退原链接；若有晚到产物，会另行清理。',
  delivery_failed:'转存或分享未能确认，已安全回退；请检查账号、策略及清理记录。',
  share_failed:'转存后的分享未成功，请检查网盘账号与清理记录。',
  transfer_failed:'转存未成功，请检查网盘账号与清理记录。',
  uncertain:'云端产物状态不确定，请先核实清理记录，不要重复转存。',
  delivery_expired:'转存分享已到期，返回原链接；清理由后台另行处理。',
  delivery_disabled:'该网盘转存策略未启用，直接返回原链接。',
  unsupported_provider:'此链接不走自动转存，直接返回原链接。',
  original_invalid:'原分享已失效，请核实来源。', resource_missing:'分享资源不存在，请核实来源。',
  account_unavailable:'登录凭据或账号不可用，请检查网盘账号。', password_invalid:'提取码不正确，请核实来源。',
  rate_limited:'上游限频，后台会按策略等待；不要连续重试。', check_failed:'未能确认有效性，后台将退避重检。',
  dependency_unavailable:'数据库、缓存或调度依赖暂不可用，请检查运行监控。',
  upstream_error:'网盘服务异常，请检查服务状态并等待恢复。',
  task_conflict:'任务状态或归属冲突，请刷新并核实当前执行状态。',
  worker_error:'后台批次异常，请结合服务日志排查；原始日志未在此暴露。',
};
export function taskReason(key?: string) { return key ? reasons[key] || `原因代码：${key}。请结合运行监控核实。` : ''; }
export function taskObservation(t: BackgroundTask) {
  if (t.validity != null) return t.validity === 1 ? '链接有效' : t.validity === 0 ? '链接失效' : '有效性未确认';
  if (t.delivery === 'reshared') return t.cacheHit ? '已复用转存分享' : '已转存并分享';
  if (t.delivery === 'original') return '返回原链接';
  if (t.resultKind === 'unavailable') return '资源不可用';
  return '';
}
