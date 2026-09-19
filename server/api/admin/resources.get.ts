import { defineEventHandler, getQuery } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { parsePagination } from "../../utils/adminQuery";
import { countManagedResourcesByApproval, listManagedResources, type ManagedResourceApprovalStatus } from "../../core/services/managedResourceService";
import { CLOUD_TYPES } from "../../../shared/cloudTypes";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const query = getQuery(event);
  const cloudType = typeof query.cloudType === "string" ? query.cloudType : "";
  const requestedApprovalStatus = typeof query.approvalStatus === "string" ? query.approvalStatus : "approved";
  const approvalStatus: ManagedResourceApprovalStatus = requestedApprovalStatus === "pending" || requestedApprovalStatus === "rejected" ? requestedApprovalStatus : "approved";
  return {
    code: 0,
    message: "success",
    data: {
      ...listManagedResources({ q: String(query.q || ""), cloudType, approvalStatus, ...parsePagination(query) }),
      approvalStatus,
      approvalCounts: countManagedResourcesByApproval(),
      cloudTypes: CLOUD_TYPES,
    },
  };
});
