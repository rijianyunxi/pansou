export interface OperationResult { status?: string }
export interface OperationRunner<T extends OperationResult> {
 post: () => Promise<T>; query: () => Promise<T>; signal?: AbortSignal;
 pending?: () => void; now?: () => number; wait?: () => Promise<void>;
 isTransportError?: (error: any) => boolean;
}
export function operationWait(signal?: AbortSignal) {
 return new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
  const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
  signal?.addEventListener('abort', abort, { once: true });
 });
}
export async function runCloudMutation<T extends OperationResult>(runner: OperationRunner<T>): Promise<T> {
 const now = runner.now || Date.now;
 const deadline = now() + 240_000;
 let result: T;
 try { result = await runner.post(); }
 catch (error: any) {
  if (error?.name === 'AbortError' || !(runner.isTransportError || ((e: any) => !e?.statusCode))(error)) throw error;
  // A lost response is not permission to replay a write.
  runner.pending?.(); result = await runner.query();
 }
 while (result.status === 'running') {
  runner.pending?.();
  if (now() > deadline) throw new Error('操作仍在运行或未确认。请保留操作编号并查询状态，不要新建重复操作。');
  await (runner.wait ? runner.wait() : operationWait(runner.signal));
  result = await runner.query();
 }
 if (result.status === 'uncertain' || result.status === 'failed') throw new Error('网盘操作失败或结果未确认，请先核对云端状态，不要重复提交。');
 return result;
}
