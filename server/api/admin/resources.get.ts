import { defineEventHandler, getQuery, setHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { listManagedResources } from "../../core/services/managedResourceService";
import { CLOUD_TYPES } from "../../../shared/cloudTypes";

export default defineEventHandler((event) => {
  requireAdminAuth(event); setHeader(event, "Cache-Control", "no-store");
  const query = getQuery(event); const page = Math.max(1, Math.floor(Number(query.page) || 1)); const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  const cloudType = typeof query.cloudType === "string" ? query.cloudType : "";
  return { code: 0, message: "success", data: { ...listManagedResources({ q: String(query.q || ""), cloudType, page, pageSize }), cloudTypes: CLOUD_TYPES } };
});
