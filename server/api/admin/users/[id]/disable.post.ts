import { defineEventHandler } from "h3";
import { setAdminUserStatusAction } from "../../../../utils/adminUserActions";

export default defineEventHandler((event) => setAdminUserStatusAction(event, "disabled"));