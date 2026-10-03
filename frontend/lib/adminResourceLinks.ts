import type {Link} from '../shared/apiModels';
export type AdminResourceLinkData = Link & {
  linkKey?: string;
  checkSupported?: boolean;
  validity?: -1 | 0 | 1;
  checkedAt?: string | null;
  lastAttemptAt?: string | null;
  stale?: boolean;
  reasonCode?: string | null;
  createdAt?: string | null;
  checkStatus?: 'unchecked' | 'unknown' | 'valid' | 'invalid';
  checkMessage?: string | null;
};
export function linkObservation(link: AdminResourceLinkData) {
  if(link.stale)return {label:'待复检',tone:'pending'};
  if(link.validity===1)return {label:'有效',tone:'valid'};
  if(link.validity===0)return {label:'失效',tone:'invalid'};
  if(link.checkedAt||link.lastAttemptAt)return {label:'待确认',tone:'pending'};
  return {label:'未检测',tone:'muted'};
}
export function resourceLinkUrl(value:string) {
  try { const url=new URL(value); return ['https:','http:'].includes(url.protocol)?url.href:undefined; }
  catch { return undefined; }
}
export function linkCheckTime(value?:string|null) {
  if(!value)return '—';
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'—':date.toLocaleString('zh-CN',{hour12:false});
}
