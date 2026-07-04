// Per-post share pages + preview images for rich social cards.
// /p/<id>  -> HTML with post-specific OG / Twitter tags, then redirects humans to the app.
// /og/<id>.png -> the client-rendered card PNG (author uploaded), or the branded fallback.
import { getStore } from "@netlify/blobs";

export const config = { path: ["/p/*", "/og/*"] };

const store = () => getStore({ name: "board", consistency: "strong" });
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts[0];
  const id = decodeURIComponent((parts[1] || "").replace(/\.png$/, ""));
  const posts = (await store().get("posts", { type: "json" })) || [];
  const post = posts.find((p) => p.id === id);

  /* ---- preview image ---- */
  if (kind === "og") {
    if (post) {
      const b64 = await store().get(`og/${id}`);
      if (b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        });
      }
    }
    return Response.redirect(`${url.origin}/hero.webp`, 302);
  }

  /* ---- share landing page (crawlers read meta, humans redirect) ---- */
  const profiles = (await store().get("profiles", { type: "json" })) || {};
  const name = post ? (profiles[post.addr] || {}).name || short(post.addr) : "One Board";
  const text = post ? post.text : "One board for the whole crypto community — ranked by likes and XRP tips.";
  const desc = text.length > 200 ? text.slice(0, 197) + "…" : text;
  const title = post ? `${name} on One Board` : "One Board — the crypto community board on XRPL";
  const ver = post ? Math.floor((post.tips || 0) * 100 + (post.likes ? post.likes.length : 0) + post.ts / 1000) : 0;
  const img = `${url.origin}/og/${encodeURIComponent(id)}.png?v=${ver}`;
  const dest = `/?post=${encodeURIComponent(id)}`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="One Board">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${esc(url.origin)}/p/${encodeURIComponent(id)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0; url=${dest}">
<script>location.replace(${JSON.stringify(dest)})</script>
</head><body style="background:#05080d;color:#e6eef8;font-family:system-ui,sans-serif;padding:48px">
<p>Opening One Board… <a href="${dest}" style="color:#2ee6c8">continue</a></p>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
};
