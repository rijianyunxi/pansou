import { randomBytes } from "node:crypto";
import { createError } from "h3";
import { getSqliteDatabase, type SqliteDatabase } from "../storage/sqlite";
import { createRandomUserId, hashPassword, type UserRow } from "../../utils/userAuth";

export type ExternalIdentity = {
  provider: string;
  providerAppId: string;
  subject: string;
  unionId?: string;
};

/** Accounts created by a first-time external login are named after the provider. */
const AUTO_USERNAME_PREFIX = "wx_";
const AUTO_USERNAME_BYTES = 6;
const AUTO_NICKNAME_PREFIX = "微信用户";
const AUTO_USERNAME_ATTEMPTS = 20;

/**
 * Create the account for a first-time external login.
 *
 * The password is random and never leaves this function, so the account is only
 * reachable through the provider that created it: nobody can sign in with a
 * username and password, and there is nothing for the user to remember.
 */
function provisionExternalUser(db: SqliteDatabase): UserRow {
  const timestamp = Date.now();
  for (let attempt = 0; attempt < AUTO_USERNAME_ATTEMPTS; attempt += 1) {
    const username = `${AUTO_USERNAME_PREFIX}${randomBytes(AUTO_USERNAME_BYTES).toString("hex")}`;
    if (db.getRow("SELECT 1 FROM users WHERE username_normalized = ?", username)) continue;
    const userId = createRandomUserId();
    db.run(
      "INSERT INTO users(id,username,username_normalized,password_hash,nickname,role,status,custom_channels_json,custom_channels_updated_at,last_login_ip,last_login_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      userId,
      username,
      username,
      hashPassword(randomBytes(32).toString("base64url")),
      `${AUTO_NICKNAME_PREFIX}${username.slice(-4)}`,
      "user",
      "active",
      "[]",
      timestamp,
      null,
      null,
      timestamp,
      timestamp,
    );
    return db.getRow<UserRow>("SELECT * FROM users WHERE id = ?", userId)!;
  }
  throw createError({ statusCode: 503, statusMessage: "Unable to provision account" });
}

/**
 * Resolve the account behind an external identity.
 *
 * This is the single resolution point for provider logins, and there is no
 * separate binding step: an unknown identity either provisions its own account
 * (`autoProvision`) or is rejected.
 *
 * `autoProvision` is the only admission lever left. Turning it off makes the
 * provider invite-only in the strictest sense — a first-time identity gets a 403
 * with no route to an account, because the former "an admin pre-creates the
 * account and the user binds it" path was removed on 2026-09-18.
 */
export function resolveExternalUser(
  identity: ExternalIdentity,
  ip: string,
  options: { autoProvision?: boolean } = {},
): UserRow {
  const { autoProvision } = options;
  const db = getSqliteDatabase();
  return db.transaction(() => {
    const linked = db.getRow<{ user_id: number }>(
      "SELECT user_id FROM auth_identities WHERE provider = ? AND provider_app_id = ? AND subject = ?",
      identity.provider, identity.providerAppId, identity.subject,
    );

    // A linked identity whose account row is gone is rejected, never
    // re-provisioned: provisioning would silently resurrect a deleted account.
    let user = linked ? db.getRow<UserRow>("SELECT * FROM users WHERE id = ?", linked.user_id) : undefined;
    if (!user && !linked && autoProvision) user = provisionExternalUser(db);
    if (!user) throw createError({ statusCode: 403, statusMessage: "External identity is not linked" });
    if (user.role === "admin") throw createError({ statusCode: 403, statusMessage: "Administrator must use the admin password login" });
    if (user.deleted_at || user.status !== "active") throw createError({ statusCode: 403, statusMessage: "Account unavailable" });

    const timestamp = Date.now();
    if (linked) {
      db.run("UPDATE auth_identities SET provider_union_id = COALESCE(?,provider_union_id), updated_at = ? WHERE provider = ? AND provider_app_id = ? AND subject = ?", identity.unionId ?? null, timestamp, identity.provider, identity.providerAppId, identity.subject);
    } else {
      db.run("INSERT INTO auth_identities(provider,provider_app_id,subject,provider_union_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", identity.provider, identity.providerAppId, identity.subject, identity.unionId ?? null, user.id, timestamp, timestamp);
    }

    db.run("UPDATE users SET last_login_at = ?, last_login_ip = ?, updated_at = ? WHERE id = ?", timestamp, ip, timestamp, user.id);
    user.last_login_at = timestamp;
    user.last_login_ip = ip;
    return user;
  });
}
