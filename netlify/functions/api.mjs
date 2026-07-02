// Consensus board API — Netlify Function (v2), storage: Netlify Blobs.
// Env vars: XUMM_API_KEY, XUMM_API_SECRET (from apps.xumm.dev), SESSION_SECRET (any long random string).
// Without Xaman keys the API runs in demo mode (random demo addresses, simulated tips).
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const XUMM = "https://xumm.app/api/v1/platform";
const MAX_POST = 420;

const store = () => getStore({ name: "board", consistency: "strong" });
const j = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

/* ---- sessions (HMAC-signed cookie) ---- */
const secret = () => process.env.SESSION_SECRET || "dev-secret-change-me";
const token = (a) => a + "." + crypto.createHmac("sha256", secret()).update(a).digest("hex").slice(0, 32);
const sessionAddr = (req) => {
  const c = (req.headers.get("cookie") || "").match(/sess=([^;]+)/)?.[1];
  if (!c) return null;
  const a = c.split(".")[0];
  return token(a) === c ? a : null;
};
const setSess = (a) => ({ "set-cookie": `sess=${token(a)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
const clearSess = { "set-cookie": "sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" };

/* ---- Xaman (Xumm) REST ---- */
const hasXumm = () => !!(process.env.XUMM_API_KEY && process.env.XUMM_API_SECRET);
async function xumm(path, method = "GET", body) {
  const r = await fetch(`${XUMM}/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "X-API-Key": process.env.XUMM_API_KEY,
      "X-API-Secret": process.env.XUMM_API_SECRET,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`xumm ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/* ---- data helpers (single-blob maps; fine at launch scale — move to Postgres when busy) ---- */
const getPosts = async () => (await store().get("posts", { type: "json" })) || [];
const setPosts = (p) => store().setJSON("posts", p);
const getMap = async (k) => (await store().get(k, { type: "json" })) || {};
const setMap = (k, v) => store().setJSON(k, v);

const demoAddr = () => {
  const chars = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
  let a = "r";
  for (let i = 0; i < 33; i++) a += chars[crypto.randomInt(chars.length)];
  return a;
};

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const me = sessionAddr(req);

  try {
    /* ---------- feed ---------- */
    if (req.method === "GET" && path === "feed") {
      const [posts, followers, following] = await Promise.all([getPosts(), getMap("followers"), getMap("following")]);
      const mySubs = (me && following[me]) || [];
      return j({
        me,
        demo: !hasXumm(),
        posts: posts.map((p) => ({
          id: p.id, addr: p.addr, text: p.text, ts: p.ts, hideTips: !!p.hideTips,
          likes: p.likes.length, liked: !!(me && p.likes.includes(me)),
          tips: p.tips, followers: (followers[p.addr] || []).length,
          subscribed: mySubs.includes(p.addr),
        })),
      });
    }

    /* ---------- sign-in ---------- */
    if (req.method === "POST" && path === "signin") {
      if (!hasXumm()) {
        const a = demoAddr();
        return j({ demo: true, account: a }, 200, setSess(a));
      }
      const p = await xumm("payload", "POST", {
        txjson: { TransactionType: "SignIn" },
        options: { expire: 5 },
        custom_meta: { instruction: "Sign in to One Board — the XRPL community board" },
      });
      return j({ uuid: p.uuid, qr: p.refs.qr_png, deeplink: p.next.always });
    }
    if (req.method === "GET" && path === "signin") {
      const p = await xumm(`payload/${url.searchParams.get("uuid")}`);
      if (p.meta.expired) return j({ expired: true });
      if (!p.meta.signed) return j({ pending: true });
      const a = p.response.account;
      return j({ account: a }, 200, setSess(a));
    }
    if (req.method === "POST" && path === "logout") return j({ ok: true }, 200, clearSess);

    /* ---------- post ---------- */
    if (req.method === "POST" && path === "post") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { text, hideTips } = await req.json();
      const t = String(text || "").trim().slice(0, MAX_POST);
      if (t.length < 3) return j({ error: "post too short" }, 400);
      const posts = await getPosts();
      const last = posts.filter((p) => p.addr === me).sort((a, b) => b.ts - a.ts)[0];
      if (last && Date.now() - last.ts < 60e3) return j({ error: "one post per minute" }, 429);
      posts.push({ id: crypto.randomUUID(), addr: me, text: t, ts: Date.now(), likes: [], tips: 0, hideTips: !!hideTips });
      await setPosts(posts);
      return j({ ok: true });
    }

    /* ---------- like (toggle, one per account) ---------- */
    if (req.method === "POST" && path === "like") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { postId } = await req.json();
      const posts = await getPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return j({ error: "not found" }, 404);
      const i = p.likes.indexOf(me);
      i > -1 ? p.likes.splice(i, 1) : p.likes.push(me);
      await setPosts(posts);
      return j({ ok: true, likes: p.likes.length, liked: i === -1 });
    }

    /* ---------- subscribe (toggle) ---------- */
    if (req.method === "POST" && path === "subscribe") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { addr } = await req.json();
      if (!addr || addr === me) return j({ error: "bad target" }, 400);
      const [followers, following] = await Promise.all([getMap("followers"), getMap("following")]);
      following[me] = following[me] || []; followers[addr] = followers[addr] || [];
      const i = following[me].indexOf(addr);
      if (i > -1) { following[me].splice(i, 1); followers[addr] = followers[addr].filter((x) => x !== me); }
      else { following[me].push(addr); followers[addr].push(me); }
      await Promise.all([setMap("followers", followers), setMap("following", following)]);
      return j({ ok: true, subscribed: i === -1, followers: followers[addr].length });
    }

    /* ---------- tip-privacy toggle on own post ---------- */
    if (req.method === "POST" && path === "privacy") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { postId } = await req.json();
      const posts = await getPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p || p.addr !== me) return j({ error: "not yours" }, 403);
      p.hideTips = !p.hideTips;
      await setPosts(posts);
      return j({ ok: true, hideTips: p.hideTips });
    }

    /* ---------- tips (non-custodial: payment goes straight to the author) ---------- */
    if (req.method === "POST" && path === "tip") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { postId, amount } = await req.json();
      const xrp = Math.min(Math.max(Number(amount) || 0, 0.1), 1000);
      const posts = await getPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return j({ error: "not found" }, 404);
      if (p.addr === me) return j({ error: "can't tip yourself" }, 400);
      if (!hasXumm()) { // demo mode: credit instantly
        p.tips += xrp; await setPosts(posts);
        return j({ demo: true, credited: true, tips: p.tips });
      }
      const pay = await xumm("payload", "POST", {
        txjson: { TransactionType: "Payment", Destination: p.addr, Amount: String(Math.round(xrp * 1e6)) },
        options: { expire: 5, submit: true },
        custom_meta: { instruction: `Tip ${xrp} XRP to ${p.addr.slice(0, 8)}… on One Board` },
      });
      await store().setJSON(`pendingtip/${pay.uuid}`, { postId, xrp, by: me });
      return j({ uuid: pay.uuid, qr: pay.refs.qr_png, deeplink: pay.next.always });
    }
    if (req.method === "GET" && path === "tip") {
      const uuid = url.searchParams.get("uuid");
      const pending = await store().get(`pendingtip/${uuid}`, { type: "json" });
      if (!pending) return j({ error: "unknown tip" }, 404);
      const p = await xumm(`payload/${uuid}`);
      if (p.meta.expired) return j({ expired: true });
      if (!p.meta.signed) return j({ pending: true });
      if (p.response.dispatched_result !== "tesSUCCESS") return j({ failed: true, result: p.response.dispatched_result });
      const done = await store().get(`tipdone/${uuid}`);
      if (!done) {
        const posts = await getPosts();
        const post = posts.find((x) => x.id === pending.postId);
        if (post) { post.tips += pending.xrp; await setPosts(posts); }
        await store().set(`tipdone/${uuid}`, "1");
      }
      return j({ credited: true, txid: p.response.txid });
    }

    return j({ error: "not found" }, 404);
  } catch (e) {
    return j({ error: String(e.message || e) }, 500);
  }
};
