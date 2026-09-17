import { defineEventHandler, setHeader } from "h3";

/** Only the landing page is indexable; /admin and /api are disallowed in robots.txt. */
export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event);
  const siteUrl = typeof config.public?.siteUrl === "string" ? config.public.siteUrl : "";
  const base = siteUrl.replace(/\/+$/, "");
  const lastmod = new Date().toISOString().slice(0, 10);
  const entries = base
    ? `<url><loc>${base}/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>`
    : "";

  setHeader(event, "content-type", "application/xml; charset=utf-8");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
});
