import { apiFetch } from '@/src/appRuntime';
import { runCloudMutation } from '@/lib/cloudDriveOperations';
import type { DriveResult } from '@/types/cloudDrive';
type Envelope = { data: DriveResult };
export function readCloud(path: string, body: unknown, signal?: AbortSignal) {
 return apiFetch<Envelope>('/api/admin/cloud-drive/' + path, { method: 'POST', body, signal, silentError: true }).then(r => r.data);
}
export function queryCloudOperation(key: string, signal?: AbortSignal) {
 return apiFetch<Envelope>('/api/admin/cloud-drive/operations/' + encodeURIComponent(key), { signal, silentError: true }).then(r => r.data);
}
export function mutateCloud(path: string, body: Record<string, unknown> & { requestKey: string }, signal?: AbortSignal, pending?: (key: string) => void) {
 return runCloudMutation({
  post: () => apiFetch<Envelope>(path, { method: 'POST', body, signal, silentError: true }).then(r => r.data),
  query: () => queryCloudOperation(body.requestKey, signal),
  signal, pending: () => pending?.(body.requestKey),
 });
}
