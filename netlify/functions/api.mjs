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
const getProfiles = async () => (await store().get("profiles", { type: "json" })) || {};
const setProfiles = (v) => store().setJSON("profiles", v);
const recordJoin = async (a) => {
  const profs = await getProfiles();
  if (!profs[a]) { profs[a] = { joined: Date.now() }; await setProfiles(profs); }
};

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
      const [posts, followers, following, profiles] = await Promise.all([getPosts(), getMap("followers"), getMap("following"), getProfiles()]);
      const mySubs = (me && following[me]) || [];
      return j({
        me,
        demo: !hasXumm(),
        posts: posts.map((p) => ({
          id: p.id, addr: p.addr, name: (profiles[p.addr] || {}).name || null, text: p.text, ts: p.ts, hideTips: !!p.hideTips,
          likes: p.likes.length, liked: !!(me && p.likes.includes(me)),
          tips: p.tips, followers: (followers[p.addr] || []).length,
          subscribed: mySubs.includes(p.addr),
          promoted: (p.promotedUntil || 0) > Date.now(),
          promoBid: p.promoBid || 0,
        })),
      });
    }

    /* ---------- sign-in ---------- */
    if (req.method === "POST" && path === "signin") {
      if (!hasXumm()) {
        const a = demoAddr();
        await recordJoin(a);
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
      await recordJoin(a);
      return j({ account: a }, 200, setSess(a));
    }
    if (req.method === "POST" && path === "logout") return j({ ok: true }, 200, clearSess);

    /* ---------- post (0.1 XRP anti-spam fee to the treasury when monetization is on) ---------- */
    if (req.method === "POST" && path === "post") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { text, hideTips } = await req.json();
      const t = String(text || "").trim().slice(0, MAX_POST);
      if (t.length < 3) return j({ error: "post too short" }, 400);
      const posts = await getPosts();
      const last = posts.filter((p) => p.addr === me).sort((a, b) => b.ts - a.ts)[0];
      if (last && Date.now() - last.ts < 60e3) return j({ error: "one post per minute" }, 429);
      const treasury = process.env.PLATFORM_WALLET;
      if (!hasXumm() || !treasury || me === treasury) { // treasury account posts free (self-payments are invalid on XRPL)
        posts.push({ id: crypto.randomUUID(), addr: me, text: t, ts: Date.now(), likes: [], tips: 0, hideTips: !!hideTips });
        await setPosts(posts);
        return j({ ok: true });
      }
      const pay = await xumm("payload", "POST", {
        txjson: { TransactionType: "Payment", Destination: treasury, Amount: "100000" },
        options: { expire: 5, submit: true },
        custom_meta: { instruction: "Publish to One Board — 0.1 XRP anti-spam fee" },
      });
      await store().setJSON(`pendingpost/${pay.uuid}`, { text: t, hideTips: !!hideTips, by: me });
      return j({ uuid: pay.uuid, qr: pay.refs.qr_png, deeplink: pay.next.always });
    }
    if (req.method === "GET" && path === "post") {
      const uuid = url.searchParams.get("uuid");
      const pending = await store().get(`pendingpost/${uuid}`, { type: "json" });
      if (!pending) return j({ error: "unknown post" }, 404);
      const p = await xumm(`payload/${uuid}`);
      if (p.meta.expired) return j({ expired: true });
      if (!p.meta.signed) return j({ pending: true });
      if (p.response.dispatched_result !== "tesSUCCESS") return j({ failed: true, result: p.response.dispatched_result });
      if (!(await store().get(`postdone/${uuid}`))) {
        const posts = await getPosts();
        posts.push({ id: crypto.randomUUID(), addr: pending.by, text: pending.text, ts: Date.now(), likes: [], tips: 0, hideTips: !!pending.hideTips });
        await setPosts(posts);
        await store().set(`postdone/${uuid}`, "1");
      }
      return j({ posted: true });
    }

    /* ---------- promote (25 XRP to the treasury -> 24h labeled promoted slot) ---------- */
    if (req.method === "POST" && path === "promote") {
      if (!me) return j({ error: "sign in first" }, 401);
      const treasury = process.env.PLATFORM_WALLET;
      if (!hasXumm() || !treasury) return j({ error: "promotion not enabled" }, 400);
      const { postId, amount } = await req.json();
      const bid = Math.min(Math.max(Number(amount) || 0, 5), 10000);
      const posts = await getPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return j({ error: "not found" }, 404);
      if (p.addr !== me) return j({ error: "you can only promote your own posts" }, 403);
      if (me === treasury) { // owner promotes free
        p.promotedUntil = Date.now() + 24 * 3600e3;
        await setPosts(posts);
        return j({ promoted: true });
      }
      const pay = await xumm("payload", "POST", {
        txjson: { TransactionType: "Payment", Destination: treasury, Amount: String(Math.round(bid * 1e6)) },
        options: { expire: 5, submit: true },
        custom_meta: { instruction: `Promote on One Board — ${bid} XRP bid for a 24h promoted slot` },
      });
      await store().setJSON(`pendingpromo/${pay.uuid}`, { postId, by: me, bid });
      return j({ uuid: pay.uuid, qr: pay.refs.qr_png, deeplink: pay.next.always });
    }
    if (req.method === "GET" && path === "promote") {
      const uuid = url.searchParams.get("uuid");
      const pending = await store().get(`pendingpromo/${uuid}`, { type: "json" });
      if (!pending) return j({ error: "unknown promotion" }, 404);
      const p = await xumm(`payload/${uuid}`);
      if (p.meta.expired) return j({ expired: true });
      if (!p.meta.signed) return j({ pending: true });
      if (p.response.dispatched_result !== "tesSUCCESS") return j({ failed: true, result: p.response.dispatched_result });
      if (!(await store().get(`promodone/${uuid}`))) {
        const posts = await getPosts();
        const post = posts.find((x) => x.id === pending.postId);
        if (post) {
          const active = (post.promotedUntil || 0) > Date.now();
          post.promoBid = (active ? (post.promoBid || 0) : 0) + (pending.bid || 0); // top-ups raise the bid
          if (!active) post.promotedUntil = Date.now() + 24 * 3600e3;
          await setPosts(posts);
        }
        await store().set(`promodone/${uuid}`, "1");
      }
      return j({ promoted: true });
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
        if (post) {
          post.tips += pending.xrp; await setPosts(posts);
          const log = (await store().get("tiplog", { type: "json" })) || [];
          log.push({ addr: post.addr, xrp: pending.xrp, ts: Date.now() });
          await store().setJSON("tiplog", log.slice(-5000));
        }
        await store().set(`tipdone/${uuid}`, "1");
      }
      return j({ credited: true, txid: p.response.txid });
    }

    /* ---------- profiles (display name + public stats) ---------- */
    if (req.method === "POST" && path === "profile") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { name } = await req.json();
      const n = String(name || "").trim();
      if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(n)) return j({ error: "3-20 chars: letters, numbers, . _ -" }, 400);
      const profs = await getProfiles();
      const taken = Object.entries(profs).find(([ad, v]) => ad !== me && (v.name || "").toLowerCase() === n.toLowerCase());
      if (taken) return j({ error: "that name is taken" }, 409);
      profs[me] = { ...(profs[me] || { joined: Date.now() }), name: n };
      await setProfiles(profs);
      return j({ ok: true, name: n });
    }
    if (req.method === "GET" && path === "profile") {
      const addr = url.searchParams.get("addr");
      if (!addr) return j({ error: "addr required" }, 400);
      const [posts, followers, profs, following] = await Promise.all([getPosts(), getMap("followers"), getProfiles(), getMap("following")]);
      const mine = posts.filter((p) => p.addr === addr).sort((x, y) => y.ts - x.ts);
      const sc = (p) => (p.likes.length + 3 * p.tips) / Math.pow((Date.now() - p.ts) / 3600e3 + 2, 1.3);
      const ranked = [...posts].sort((x, y) => sc(y) - sc(x));
      const best = mine.length ? Math.min(...mine.map((p) => ranked.findIndex((x) => x.id === p.id) + 1)) : 0;
      const showTips = (p) => !p.hideTips || me === addr;
      return j({
        addr, name: (profs[addr] || {}).name || null, joined: (profs[addr] || {}).joined || null,
        followers: (followers[addr] || []).length,
        subscribed: !!(me && (following[me] || []).includes(addr)),
        postCount: mine.length,
        totalTips: mine.reduce((s, p) => s + (showTips(p) ? p.tips : 0), 0),
        totalLikes: mine.reduce((s, p) => s + p.likes.length, 0),
        bestRank: best,
        posts: mine.slice(0, 20).map((p) => ({ id: p.id, text: p.text, ts: p.ts, likes: p.likes.length, tips: showTips(p) ? p.tips : null })),
      });
    }

    /* ---------- earnings leaderboard ---------- */
    if (req.method === "GET" && path === "leaders") {
      const [posts, profs, log] = await Promise.all([
        getPosts(), getProfiles(),
        store().get("tiplog", { type: "json" }).then((x) => x || []),
      ]);
      const cutoff = Date.now() - 7 * 24 * 3600e3;
      const week = {};
      for (const e of log) if (e.ts > cutoff) week[e.addr] = (week[e.addr] || 0) + e.xrp;
      const all = {};
      for (const p of posts) if (!p.hideTips && p.tips) all[p.addr] = (all[p.addr] || 0) + p.tips;
      const top = (m) => Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 5)
        .map(([ad, xrp]) => ({ addr: ad, xrp, name: (profs[ad] || {}).name || null }));
      return j({ week: top(week), all: top(all) });
    }

    /* ---------- store per-post OG image (client canvas PNG; author only) ---------- */
    if (req.method === "POST" && path === "ogimage") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { postId, dataUrl } = await req.json();
      if (!postId || typeof dataUrl !== "string") return j({ error: "bad request" }, 400);
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      if (b64.length > 4_000_000) return j({ error: "too large" }, 413);
      const posts = await getPosts();
      const p = posts.find((x) => x.id === postId);
      if (!p) return j({ error: "not found" }, 404);
      if (p.addr !== me) return j({ error: "not your post" }, 403);
      await store().set(`og/${postId}`, b64);
      return j({ ok: true });
    }

    return j({ error: "not found" }, 404);
  } catch (e) {
    return j({ error: String(e.message || e) }, 500);
  }
};
