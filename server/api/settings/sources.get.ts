import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getUnifiedSourceVersion, listUnifiedSources } from "../../core/services/sourceCatalog";
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return {
    code: 0,
    data: listUnifiedSources(),
    version: getUnifiedSourceVersion(),
    meta: {
      sourceModel: "resource",
    },
  };
});
