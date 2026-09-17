import { defineEventHandler, setHeader } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { exportConfiguredSources } from "../../../core/services/sourceCatalog";

/**
 * 当前无调用方：2026-09-18 孤儿接口扫描确认，仓库内没有任何地方请求本路由，
 * 后台管理页也没有对应的导出入口。走 requireAdminAuth，不构成泄露风险。
 * 保留待定（可能原计划用于手工运维导出）；若确认无用可直接删除本文件。
 */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const payload = exportConfiguredSources();
  // The generated file is a JSON-only ES module, so it can be imported back
  // without evaluating arbitrary JavaScript.
  const source = `export default ${JSON.stringify(payload, null, 2)};\n`;
  setHeader(event, "Content-Type", "text/javascript; charset=utf-8");
  setHeader(event, "Content-Disposition", 'attachment; filename="panhub-sources.js"');
  return source;
});
