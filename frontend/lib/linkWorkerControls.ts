import type { TaskKind } from './backgroundTasks';
import type { WorkerStatus } from '../components/monitor/monitorView';

export const LINK_LANES = {
  sync: { endpoint: 'link-sync', flag: 'syncEnabled', name: '关联同步', hint: '只控制资源关联同步，暂停后待同步资源保留在队列。' },
  checks: { endpoint: 'link-check', flag: 'checkEnabled', name: '有效性检测', hint: '只控制后台检测调度，保留账号、频率、额度和缓存参数；暂停期间队列保留。' },
  cleanup: { endpoint: 'cleanup', flag: 'enabled', name: '链接清理', hint: '只控制到期与晚到转存产物的清理；暂停期间云端产物会保留，清理会延后。' },
  maintenance: { endpoint: 'link-maintenance', flag: 'maintenanceEnabled', name: '状态维护', hint: '只控制状态过期、超时恢复及历史维护；暂停期间这些维护会延后，不影响异常记录写入。' },
} as const;
export function linkLane(kind: TaskKind) { return kind === 'resolve' ? null : LINK_LANES[kind]; }
export type LinkControlKind = 'link-schedule' | typeof LINK_LANES[keyof typeof LINK_LANES]['endpoint'];
export type ScheduledLinkKind = keyof typeof LINK_LANES;
export interface LinkWorkerSettings {
  linkScheduleEnabled: boolean; linkEnabled: boolean; linkSyncEnabled: boolean;
  linkCheckEnabled: boolean; linkMaintenanceEnabled: boolean;
}
export function workerSettings(settings: LinkWorkerSettings) {
  return { scheduleEnabled: settings.linkScheduleEnabled, enabled: settings.linkEnabled,
    syncEnabled: settings.linkSyncEnabled, checkEnabled: settings.linkCheckEnabled,
    maintenanceEnabled: settings.linkMaintenanceEnabled };
}
export function laneEnabled(kind: ScheduledLinkKind, worker: WorkerStatus | null, checkPolicy?: boolean) {
  const flag = worker?.[LINK_LANES[kind].flag];
  if (flag == null) return undefined;
  if (kind === 'checks') return checkPolicy == null ? undefined : flag && checkPolicy;
  return flag;
}
export function laneView(kind: ScheduledLinkKind, worker: WorkerStatus | null, checkPolicy?: boolean, readyAccounts?: number) {
  const enabled = laneEnabled(kind, worker, checkPolicy);
  if (enabled == null || worker?.scheduleEnabled == null) return { state:'uncertain', label:'状态未知' };
  if (kind === 'checks' && checkPolicy === false) return { state:'paused', label:'检测未启用' };
  if (!enabled) return { state:'paused', label:'已暂停' };
  if (!worker.scheduleEnabled) return { state:'queued', label:'总调度暂停' };
  if (worker.state === 'offline') return { state:'blocked', label:'Worker 离线' };
  if (worker.state !== 'online') return { state:'uncertain', label:'状态未知' };
  if (kind === 'checks' && readyAccounts === 0) return { state:'blocked', label:'无可用账号' };
  if (kind === 'checks' && readyAccounts == null) return { state:'uncertain', label:'账号状态未知' };
  return { state:'completed', label:'可调度' };
}
