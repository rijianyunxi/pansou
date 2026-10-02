import type { ProviderKey } from './linkPolicy';
export type CloudAccount = {
  provider: ProviderKey; configured: boolean; status: string; displayName?: string;
  subjectId?: string; storageScope?: string; source?: string; bindingEpoch: number;
  tokenRevision: number; refreshable: boolean; qrSupported: boolean; officialUrl: string;
  expiresAt?: string; lastVerifiedAt?: string; lastRefreshAt?: string; lastErrorCode?: string;
};
export type AccountCheckFeedback = { state: 'checking' | 'success' | 'error'; message: string };
export function accountCheckResult(account?: CloudAccount): AccountCheckFeedback {
  if (account?.configured && account.status === 'ready') return { state: 'success', message: '账号验证通过' };
  if (!account) return { state: 'error', message: '未返回账号状态，请刷新后重试' };
  if (!account.configured || account.status === 'disconnected') return { state: 'error', message: '账号未连接，请先连接网盘' };
  return { state: 'error', message: account.lastErrorCode ? authReason(account.lastErrorCode) : '账号尚未验证通过，请重新连接' };
}
export type LoginSession = {id: string; provider: ProviderKey; status: string; qrImage?: string; expiresAt: string; errorCode?: string; intervalSeconds: number};
const labels: Record<string,string> = {
  disconnected:'未连接', unverified:'待验证', ready:'已连接', degraded:'维护暂时异常',
  reauthorization_required:'需要重新连接', starting:'正在生成二维码', waiting:'等待扫码',
  scanned:'已扫码，请在手机确认', verifying:'正在验证账号及访问权限', connected:'连接成功',
  expired:'二维码已过期', denied:'授权已拒绝', cancelled:'已取消', failed:'连接失败',
};
const errors: Record<string,string> = {
  account_mismatch:'扫码账号或存储空间与原账号不一致。若要切换，请选择“更换账号”。',
  account_unverified:'原账号凭证已失效且从未完成身份核实，无法确认是否为同一账号。可重新扫码后确认“更换账号”，或先“断开连接”再扫码连接；旧凭证的转存产物不会被新账号清理。',
  login_verification_failed:'上次扫码未完成连接，旧版未记录具体失败阶段。请重新生成二维码；重复失败时检查服务端诊断。',
  qr_start_failed:'无法生成二维码，请重试或使用高级导入。', qr_expired:'二维码已过期，请重新生成。',
  authorization_denied:'你已在手机上拒绝授权。', reauthorization_required:'授权已失效，请重新连接。',
  verification_required:'请在官方网站完成额外验证后重新连接。',
  credential_key_unavailable:'服务端凭证密钥不可用，请恢复原密钥或检查配置。',
  refresh_uncertain:'刷新请求结果未确认，为防止重复使用旧刷新令牌，请重新授权。',
  authorization_exchange_uncertain:'扫码授权兑换结果未确认。为避免重复使用一次性票据，请重新生成二维码并扫码。',
  client_configuration_required:'续期缺少同一官方会话的客户端配置，请高级导入完整 client_id 和所需设备字段，不要混用不同客户端的令牌。',
  refresh_commit_failed:'刷新后的凭证未能安全保存，请重新授权。',
  network_error:'认证服务连接失败，系统会稍后再试。', rate_limited:'认证频率受限，系统会稍后再试。',
  state_changed:'扫码期间账号状态或登录会话已变化，凭证未保存。请重新生成二维码再扫码。',
  access_rejected:'访问令牌被拒绝，系统将尝试续期；不会重做先前的写操作。',
  provider_protocol_error:'网盘认证协议异常，请重新连接或使用高级导入。',
  verification_failed:'凭证更新后未完成身份及权限验证，请重新连接。',
  permission_denied:'网盘拒绝访问，请检查该账号的目录访问权限。',
};
export function accountStatus(status:string){return labels[status]||'状态待确认';}
/**
 * A stored credential that never completed identity verification has no account
 * to re-authorize: the server cannot tell whether the account being scanned is
 * the same one, so it refuses `reauthorize` outright. Re-scanning in that state
 * is therefore an explicit rebind, which is exactly what `replace` states.
 */
export function loginRequest(account:Pick<CloudAccount,'configured'|'subjectId'>,replace=false){
  const rebind=replace||(account.configured&&!account.subjectId);
  return {rebind,intent:(rebind?'replace':account.configured?'reauthorize':'connect') as 'connect'|'reauthorize'|'replace'};
}
export function rebindQuestion(replace:boolean){
  return replace
    ?'更换网盘账号或阿里存储空间后，旧账号的转存产物不会被新账号清理。确认继续？'
    :'原凭证尚未完成身份核实，无法确认与即将登录的账号是否相同。继续后将以本次登录的账号为准；旧凭证的转存产物不会被新账号清理。确认继续？';
}
export function scanInstructions(provider:ProviderKey){
  const apps:Record<ProviderKey,string>={quark:'夸克 App 的网盘扫一扫',baidu:'百度网盘 App 的扫一扫',aliyun:'阿里云盘 App 的扫一扫',guangya:'光鸭网盘官方 App 的扫码功能',xunlei:'迅雷官方 App'};
  return `请使用${apps[provider]}，扫码后在手机端确认授权。请勿用其他网盘 App 扫码，也不要扫描来历不明的二维码。`;
}
const stages:Record<string,string>={session_context:'读取扫码会话',token_exchange:'兑换扫码授权',account_identity:'核实官方账号',root_access:'验证根目录访问',credential_save:'保存账号凭证'};
const stageErrors:Record<string,string>={
  'token_exchange:reauthorization_required':'官方服务未接受本次扫码授权；票据是一次性的，可能已过期或被使用。请重新生成二维码并扫码。',
  'account_identity:reauthorization_required':'扫码已确认，但未能建立官方登录会话。请重新生成二维码再试；重复失败请改用高级导入。',
  'credential_save:state_changed':'扫码期间账号状态或登录会话已变化，凭证未保存。请重新生成二维码再扫码；若反复出现，请先刷新页面确认账号状态。',
};
export function authReason(code?:string){
  if(!code)return '';
  if(stageErrors[code])return stageErrors[code];
  const [stage,reason]=code.split(':');
  if(stages[stage]&&errors[reason])return `${stages[stage]}失败：${errors[reason]}`;
  return errors[code]||'账号维护异常，请检查登录状态。';
}
export function sessionActive(status:string){return ['starting','waiting','scanned','verifying'].includes(status);}
export function sessionExpired(session:LoginSession,now=Date.now()){return sessionActive(session.status)&&Date.parse(session.expiresAt)<=now;}
export function usableAccount(account?:CloudAccount){return !!account?.configured&&['ready','degraded'].includes(account.status);}
export function safeQrImage(value?:string){return !!value&&/^data:image\/(?:png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(value);}
