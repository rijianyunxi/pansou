import { defineEventHandler, setHeader } from "h3";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event);
  const siteUrl = typeof config.public?.siteUrl === "string"
    ? config.public.siteUrl.replace(/\/+$/, "")
    : "";

  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api/",
  ];

  if (siteUrl) lines.push(`Sitemap: ${siteUrl}/sitemap.xml`);

  setHeader(event, "content-type", "text/plain; charset=utf-8");
  return `${lines.join("\n")}\n`;
});
