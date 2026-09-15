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
function rowToRecord(row: any): TgAccountRecord {
  return { id: row.id, name: row.name, ...(row.phone ? { phone: row.phone } : {}), apiId: row.api_id, ...(row.api_hash ? { apiHash: row.api_hash } : {}), ...(row.session_string ? { sessionString: row.session_string } : {}), enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at };
}
function readOne(id: string): TgAccountRecord | undefined {
  const row = getSqliteDatabase().getRow<any>("SELECT id,name,phone,api_id,api_hash,session_string,enabled,created_at,updated_at FROM tg_accounts WHERE id=?", id);
  return row ? rowToRecord(row) : undefined;
}
function readAll(): TgAccountRecord[] {
  return getSqliteDatabase().allRows<any>("SELECT id,name,phone,api_id,api_hash,session_string,enabled,created_at,updated_at FROM tg_accounts ORDER BY name COLLATE NOCASE,id").map(rowToRecord);
}

function view(record: TgAccountRecord): TgAccountView {
  const { apiHash: _apiHash, sessionString: _sessionString, ...safe } = record;
  const app = getTelegramAppConfig();
  return { ...safe, apiId: app.apiId || record.apiId, hasApiHash: Boolean(app.apiHash || record.apiHash), hasSession: Boolean(record.sessionString) };
}
export class SqliteTgAccountStore {
  list(): TgAccountView[] { return readAll().map(view); }
  get(id: string): TgAccountRecord | undefined { const value = readOne(id); return value ? structuredClone(value) : undefined; }
  save(input: Partial<TgAccountRecord>): TgAccountView {
    const id = String(input.id || "").trim().toLowerCase();
    const name = String(input.name || "").trim();
    const config = getTelegramAppConfig();
    const old = readOne(id);
    const apiId = Number(input.apiId || old?.apiId || config.apiId);
    if (!ID_RE.test(id)) throw new Error("账户 ID 只能是 2-64 位小写字母、数字、_ 或 -");
    if (!name || name.length > 100) throw new Error("账户名称不能为空且不能超过 100 个字符");
    if (!Number.isInteger(apiId) || apiId < 1) throw new Error("服务端尚未配置有效的 TELEGRAM_API_ID，请检查 .env");
    const now = new Date().toISOString();
    const record: TgAccountRecord = {
      id, name, apiId, ...(typeof input.phone === "string" && input.phone.trim() ? { phone: input.phone.trim().slice(0, 32) } : old?.phone ? { phone: old.phone } : {}),
      ...(typeof input.apiHash === "string" && input.apiHash.trim() ? { apiHash: input.apiHash.trim() } : old?.apiHash ? { apiHash: old.apiHash } : {}),
      ...(typeof input.sessionString === "string" && input.sessionString.trim() ? { sessionString: input.sessionString.trim() } : old?.sessionString ? { sessionString: old.sessionString } : {}),
      enabled: typeof input.enabled === "boolean" ? input.enabled : old?.enabled ?? true,
      createdAt: old?.createdAt || now, updatedAt: now,
    };
    const db = getSqliteDatabase();
    db.run("INSERT INTO tg_accounts(id,name,phone,api_id,api_hash,session_string,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,api_id=excluded.api_id,api_hash=excluded.api_hash,session_string=excluded.session_string,enabled=excluded.enabled,updated_at=excluded.updated_at", record.id, record.name, record.phone || null, record.apiId, record.apiHash || null, record.sessionString || null, record.enabled ? 1 : 0, record.createdAt, record.updatedAt);
    return view(record);
  }
  updateEnabled(id: string, enabled: boolean): TgAccountView {
    const record = readOne(id); if (!record) throw new Error("Telegram 账户不存在");
    const updatedAt = new Date().toISOString();
    const result = getSqliteDatabase().run("UPDATE tg_accounts SET enabled=?,updated_at=? WHERE id=?", enabled ? 1 : 0, updatedAt, id);
    if (!result.changes) throw new Error("Telegram 账户不存在");
    record.enabled = enabled; record.updatedAt = updatedAt; return view(record);
  }
  delete(id: string): void {
    const result = getSqliteDatabase().run("DELETE FROM tg_accounts WHERE id=?", id);
    if (!result.changes) throw new Error("Telegram 账户不存在");
  }
}

let store: SqliteTgAccountStore | undefined;
export function getTgAccountStore(): SqliteTgAccountStore { return store || (store = new SqliteTgAccountStore()); }
