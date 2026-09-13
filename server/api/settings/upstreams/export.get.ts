import { defineEventHandler, setHeader } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { exportConfiguredUpstreams } from "../../../core/services/upstreamCatalog";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const payload = exportConfiguredUpstreams();
  // The generated file is a JSON-only ES module, so it can be imported back
  // without evaluating arbitrary JavaScript.
  const source = `export default ${JSON.stringify(payload, null, 2)};\n`;
  setHeader(event, "Content-Type", "text/javascript; charset=utf-8");
  setHeader(event, "Content-Disposition", 'attachment; filename="panhub-upstreams.js"');
  return source;
});
