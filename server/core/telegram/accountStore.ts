import { getSqliteDatabase } from "../storage/sqlite";
import { getTelegramAppConfig } from "../../utils/telegramConfig";

export interface TgAccountRecord {
  id: string;
  name: string;
  phone?: string;
  apiId: number;
  /** Legacy/custom value. New UI always uses the server .env credentials. */
  apiHash?: string;
  sessionString?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface TgAccountView extends Omit<TgAccountRecord, "apiHash" | "sessionString"> {
  hasApiHash: boolean;
  hasSession: boolean;
}
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
function read(): Record<string, TgAccountRecord> {
  const rows = getSqliteDatabase().allRows<any>("SELECT id,name,phone,api_id,api_hash,session_string,enabled,created_at,updated_at FROM tg_accounts");
  return Object.fromEntries(rows.map(row => [row.id, { id: row.id, name: row.name, ...(row.phone ? { phone: row.phone } : {}), apiId: row.api_id, ...(row.api_hash ? { apiHash: row.api_hash } : {}), ...(row.session_string ? { sessionString: row.session_string } : {}), enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at }]));
}
function write(records: Record<string, TgAccountRecord>): void {
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("DELETE FROM tg_accounts");
    for (const record of Object.values(records)) db.run("INSERT INTO tg_accounts(id,name,phone,api_id,api_hash,session_string,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", record.id, record.name, record.phone || null, record.apiId, record.apiHash || null, record.sessionString || null, record.enabled ? 1 : 0, record.createdAt, record.updatedAt);
  });
}
function view(record: TgAccountRecord): TgAccountView {
  const { apiHash: _apiHash, sessionString: _sessionString, ...safe } = record;
  const app = getTelegramAppConfig();
  return { ...safe, apiId: app.apiId || record.apiId, hasApiHash: Boolean(app.apiHash || record.apiHash), hasSession: Boolean(record.sessionString) };
}
export class SqliteTgAccountStore {
  list(): TgAccountView[] { return Object.values(read()).map(view).sort((a, b) => a.name.localeCompare(b.name)); }
  get(id: string): TgAccountRecord | undefined { const value = read()[id]; return value ? structuredClone(value) : undefined; }
  save(input: Partial<TgAccountRecord>): TgAccountView {
    const id = String(input.id || "").trim().toLowerCase();
    const name = String(input.name || "").trim();
    const config = getTelegramAppConfig();
    const records = read(); const old = records[id];
    const apiId = Number(input.apiId || old?.apiId || config.apiId);
    if (!ID_RE.test(id)) throw new Error("账户 ID 只能是 2-64 位小写字母、数字、_ 或 -");
    if (!name || name.length > 100) throw new Error("账户名称不能为空且不能超过 100 个字符");
    if (!Number.isInteger(apiId) || apiId < 1) throw new Error("服务端尚未配置有效的 TELEGRAM_API_ID，请检查 .env");
    const now = new Date().toISOString();
    const phone = typeof input.phone === "string" && input.phone.trim() ? input.phone.trim().slice(0, 32) : old?.phone;
    const record: TgAccountRecord = {
      id, name, apiId, ...(phone ? { phone } : {}),
      ...(typeof input.apiHash === "string" && input.apiHash.trim() ? { apiHash: input.apiHash.trim() } : old?.apiHash ? { apiHash: old.apiHash } : {}),
      ...(typeof input.sessionString === "string" && input.sessionString.trim() ? { sessionString: input.sessionString.trim() } : old?.sessionString ? { sessionString: old.sessionString } : {}),
      enabled: typeof input.enabled === "boolean" ? input.enabled : old?.enabled ?? true,
      createdAt: old?.createdAt || now, updatedAt: now,
    };
    records[id] = record; write(records); return view(record);
  }
  updateEnabled(id: string, enabled: boolean): TgAccountView {
    const records = read(); const record = records[id]; if (!record) throw new Error("TG 账户不存在");
    record.enabled = enabled; record.updatedAt = new Date().toISOString(); records[id] = record; write(records); return view(record);
  }
  delete(id: string): void { const records = read(); if (!records[id]) throw new Error("TG 账户不存在"); delete records[id]; write(records); }
}
let store: SqliteTgAccountStore | undefined;
export function getTgAccountStore(): SqliteTgAccountStore { return store || (store = new SqliteTgAccountStore()); }
