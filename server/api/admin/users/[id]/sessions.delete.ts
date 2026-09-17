import { defineEventHandler } from "h3";
import { revokeAdminUserSessionsAction } from "../../../../utils/adminUserActions";

export default defineEventHandler((event) => revokeAdminUserSessionsAction(event));