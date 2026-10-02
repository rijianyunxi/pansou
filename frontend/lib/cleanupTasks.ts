import { DELIVERY_PROVIDERS } from './linkPolicy.ts';

const CLEANUP_STATUSES = ['attention', 'all', 'queued', 'running', 'blocked', 'failed', 'completed'] as const;
export function cleanupFilters(query: Record<string, unknown>) {
  const scalar = (value: unknown) => typeof value === 'string' ? value : '';
  const status = scalar(query.status), provider = scalar(query.provider), page = Number(scalar(query.page));
  return {
    status: CLEANUP_STATUSES.includes(status as typeof CLEANUP_STATUSES[number]) ? status : 'attention',
    provider: DELIVERY_PROVIDERS.some(p => p.key === provider) ? provider : '',
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1,
  };
}
const labels: Record<string, string> = {
  queued: '等待清理', running: '清理中', completed: '已完成', blocked: '已阻塞', failed: '已失败',
  verify: '核实归属', revoke_shares: '撤销分享', delete_files: '删除文件', verify_deleted: '确认删除',
  ready: '可交付', saved: '已转存', share_created: '已创建分享', expiring: '等待清理', cleaning: '清理中', deleted: '已清理', uncertain: '结果待核实',
  directory_intent: '目录创建待确认', directory_created: '目录已创建', transfer_intent: '转存结果待确认', share_intent: '分享创建待确认',
};
export function cleanupLabel(value: string | null | undefined) { return value ? labels[value] || value : '未记录'; }
export function cleanupError(code: string | null, status: string) {
  const reasons: Record<string, string> = {
    ownership_verification_required: '账号、目录归属或文件清单未通过校验。请恢复原账号凭据，并核实目录是否被修改。',
    cleanup_credentials_or_permissions: '网盘拒绝登录凭据、权限或请求参数。请检测登录态并核实账号配置。',
    waiting_auth: '正在等待原网盘账号重新授权，不消耗清理重试次数；同一账号验证成功后恢复。',
    cleanup_timeout: '本次清理超时，结果尚未确认。请检查网盘状态后重试。',
    cleanup_busy: '该网盘正在处理其他写操作，约 10 秒后自动重试。',
    cleanup_retry: '上游操作未成功或结果未确认，请检查登录态与网盘服务。',
    deadline_exceeded: '取链超过 5 秒，正在清理未交付产物。',
  };
  if (!code) return '';
  const reason = reasons[code] || `未识别的失败原因（${code}），请查看运行诊断。`;
  return status === 'blocked' && !['ownership_verification_required','waiting_auth'].includes(code) ? `${reason} 自动重试已停止，核实后可手动重试。` : reason;
}
export function retryUnavailable(reason: string | null | undefined) {
  return ({not_due:'尚未到期，不能提前清理',running:'任务正在执行，不能重复入队',completed:'清理已完成，无需重试',waiting_auth:'请到网盘账号菜单重新连接原账号，验证成功后自动恢复'} as Record<string,string>)[reason || ''] || '暂不可重试，请刷新状态';
}
