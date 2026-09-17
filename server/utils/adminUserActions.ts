import { getRouterParam, type H3Event } from "h3";
import {
  parseUserId,
  revokeAdminUserSessions,
  setAdminUserStatus,
} from "../core/services/adminUserService";
import { requireAdminAuth } from "./requireAdminAuth";

/** Activate or disable an account from the console. */
export function setAdminUserStatusAction(event: H3Event, status: "active" | "disabled") {
  requireAdminAuth(event);
  const user = setAdminUserStatus(parseUserId(getRouterParam(event, "id")), status);
  return { code: 0, message: status === "active" ? "enabled" : "disabled", data: { user } };
}

/**
 * Revoke every session of an account.
 *
 * Served only by `DELETE /:id/sessions`. The former `POST /:id/revoke-sessions`
 * alias existed purely so pre-existing clients kept working and was removed
 * (2026-09-18) — nothing in this repository ever called it.
 */
export function revokeAdminUserSessionsAction(event: H3Event) {
  requireAdminAuth(event);
  const data = revokeAdminUserSessions(parseUserId(getRouterParam(event, "id")));
  return { code: 0, message: "sessions revoked", data };
}
