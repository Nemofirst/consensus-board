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

/* ---- The Ten (Harberger slots) + Golden Hour + replies + discoverers ---- */
const SLOT_N = 10, TAX_RATE = 0.03, MIN_PRICE = 5, MAX_PRICE = 10000, MAX_REPLY = 280;
const START_PRICE = 20, REVERT_FACTOR = 0.8, POT_SHARE = 0.5; // house = original owner of all slots; half of taxes/fees fund the pot
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const slotTax = (price, days) => Math.max(0.5, +(price * TAX_RATE * days).toFixed(2));
const getSlots = async () => {
  const s = (await store().get("slots", { type: "json" })) || [];
  return Array.from({ length: SLOT_N }, (_, i) => s[i] || { n: i, house: true, price: START_PRICE });
};
/* lapsed player-held slots revert to the house at 80% of their last price */
const revertSlots = async () => {
  const slots = await getSlots();
  let changed = false;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s.house && s.holder && (s.paidUntil || 0) < Date.now()) {
      slots[i] = { n: i, house: true, price: Math.max(START_PRICE, Math.round((s.price || START_PRICE) * REVERT_FACTOR)) };
      changed = true;
    }
    if (!s.house && !s.holder) { slots[i] = { n: i, house: true, price: START_PRICE }; changed = true; }
  }
  if (changed) await setSlots(slots);
  return slots;
};
const setSlots = (s) => store().setJSON("slots", s);
const slotLive = (s) => !!(s && (s.house || (s.holder && (s.paidUntil || 0) > Date.now())));
const getPot = async () => (await store().get("pot", { type: "json" })) || { amount: 0, day: dayKey() };
const setPot = (p) => store().setJSON("pot", p);
const addPot = async (x) => { const p = await getPot(); p.amount = +(p.amount + x).toFixed(6); await setPot(p); };
const addDisc = (p, a) => { if (a && a !== p.addr) { p.disc = p.disc || []; if (!p.disc.includes(a) && p.disc.length < 5) p.disc.push(a); } };
const ghScore = (p) => p.likes.length + 3 * p.tips + 1.5 * (p.assist || 0);

async function payoutXRP(dest, xrp) {
  const seed = process.env.PLATFORM_WALLET_SEED;
  if (!seed) return { queued: true };
  const xrpl = await import("xrpl");
  const client = new xrpl.Client(process.env.XRPL_WSS || "wss://xrplcluster.com");
  try {
    await client.connect();
    const wallet = xrpl.Wallet.fromSeed(seed);
    const tx = await client.submitAndWait(
      { TransactionType: "Payment", Account: wallet.address, Destination: dest, Amount: String(Math.round(xrp * 1e6)) },
      { autofill: true, wallet }
    );
    return { txid: tx.result.hash };
  } finally { try { await client.disconnect(); } catch {} }
}

/* Golden Hour: settle lazily on the first request of a new UTC day. Pot rolls over if the day had no qualifying post. */
async function settleGH() {
  const pot = await getPot();
  const today = dayKey();
  if (pot.day === today) return pot;
  const prevDay = pot.day;
  if (await store().get(`ghdone/${prevDay}`)) { pot.day = today; await setPot(pot); return pot; }
  await store().set(`ghdone/${prevDay}`, "1"); // idempotency marker first
  const posts = await getPosts();
  const start = Date.parse(prevDay + "T00:00:00Z"), end = start + 86400e3;
  const treasury = process.env.PLATFORM_WALLET;
  const cands = posts.filter((p) => p.ts >= start && p.ts < end && p.addr !== treasury && ghScore(p) > 0);
  if (cands.length && pot.amount >= 0.01) {
    const win = cands.sort((a, b) => ghScore(b) - ghScore(a))[0];
    const amount = +pot.amount.toFixed(2);
    let pay = {};
    try { pay = await payoutXRP(win.addr, amount); } catch (e) { pay = { failed: String(e.message || e) }; }
    const profs = await getProfiles();
    pot.last = { day: prevDay, addr: win.addr, name: (profs[win.addr] || {}).name || null, xrp: amount, postId: win.id, ...pay };
    const log = (await store().get("ghlog", { type: "json" })) || [];
    log.push(pot.last);
    await store().setJSON("ghlog", log.slice(-365));
    pot.amount = 0;
  }
  pot.day = today;
  await setPot(pot);
  return pot;
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const me = sessionAddr(req);

  try {
    /* ---------- feed ---------- */
    if (req.method === "GET" && path === "feed") {
      const [posts, followers, following, profiles, replMap, slots, pot] = await Promise.all([
        getPosts(), getMap("followers"), getMap("following"), getProfiles(), getMap("replies"), revertSlots(), settleGH(),
      ]);
      const mySubs = (me && following[me]) || [];
      const nameOf = (a) => (profiles[a] || {}).name || null;
      return j({
        me,
        demo: !hasXumm(),
        posts: posts.map((p) => ({
          id: p.id, addr: p.addr, name: nameOf(p.addr), text: p.text, ts: p.ts, hideTips: !!p.hideTips,
          likes: p.likes.length, liked: !!(me && p.likes.includes(me)),
          tips: p.tips, assist: p.assist || 0, followers: (followers[p.addr] || []).length,
          subscribed: mySubs.includes(p.addr),
          promoted: (p.promotedUntil || 0) > Date.now(),
          promoBid: p.promoBid || 0,
          replies: (replMap[p.id] || []).length,
          disc: (p.disc || []).map((a) => ({ addr: a, name: nameOf(a) })),
        })),
        slots: slots.map((s) => {
          if (s.house) return {
            n: s.n, live: true, house: true,
            holder: process.env.PLATFORM_WALLET || null, name: "One Board",
            price: s.price, paidUntil: 0,
            text: s.text || "House slot — buy it and your post sits here, above the entire board.",
            postId: null, mine: !!(me && me === process.env.PLATFORM_WALLET),
          };
          const post = posts.find((p) => p.id === s.postId);
          return {
            n: s.n, live: true, house: false,
            holder: s.holder, name: nameOf(s.holder),
            price: s.price, paidUntil: s.paidUntil,
            text: post ? post.text : s.text || "", postId: s.postId,
            mine: !!(me && me === s.holder),
          };
        }),
        gh: { pot: +pot.amount.toFixed(2), day: pot.day, last: pot.last || null },
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
        await addPot(+(0.1 * POT_SHARE).toFixed(6));
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
      if (i === -1) addDisc(p, me);
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
          post.tips += pending.xrp; addDisc(post, pending.by); await setPosts(posts);
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
      const sc = (p) => (p.likes.length + 3 * p.tips + 1.5 * (p.assist || 0)) / Math.pow((Date.now() - p.ts) / 3600e3 + 2, 1.3);
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
      if (p.addr !== me && (await store().get(`og/${postId}`))) return j({ ok: true, skipped: true });
      await store().set(`og/${postId}`, b64);
      return j({ ok: true });
    }

    /* ---------- replies (free; tips on replies add 'assist' weight to the parent post) ---------- */
    if (req.method === "GET" && path === "replies") {
      const postId = url.searchParams.get("postId");
      const [replMap, profiles] = await Promise.all([getMap("replies"), getProfiles()]);
      return j({
        replies: (replMap[postId] || []).map((r) => ({
          id: r.id, addr: r.addr, name: (profiles[r.addr] || {}).name || null, text: r.text, ts: r.ts, tips: r.tips || 0,
        })),
      });
    }
    if (req.method === "POST" && path === "reply") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { postId, text } = await req.json();
      const t = String(text || "").trim().slice(0, MAX_REPLY);
      if (t.length < 2) return j({ error: "reply too short" }, 400);
      const posts = await getPosts();
      if (!posts.find((x) => x.id === postId)) return j({ error: "not found" }, 404);
      const replMap = await getMap("replies");
      const list = (replMap[postId] = replMap[postId] || []);
      const lastMine = [...list].reverse().find((r) => r.addr === me);
      if (lastMine && Date.now() - lastMine.ts < 15e3) return j({ error: "one reply per 15s" }, 429);
      const rep = { id: crypto.randomUUID(), addr: me, text: t, ts: Date.now(), tips: 0 };
      list.push(rep);
      await setMap("replies", replMap);
      return j({ ok: true, count: list.length });
    }

    /* ---------- tip a reply (non-custodial to the replier; parent post earns 'assist' ranking weight) ---------- */
    if (req.method === "POST" && path === "tipreply") {
      if (!me) return j({ error: "sign in first" }, 401);
      const { postId, replyId, amount } = await req.json();
      const xrp = Math.min(Math.max(Number(amount) || 0, 0.1), 1000);
      const replMap = await getMap("replies");
      const r = (replMap[postId] || []).find((x) => x.id === replyId);
      if (!r) return j({ error: "not found" }, 404);
      if (r.addr === me) return j({ error: "can't tip yourself" }, 400);
      if (!hasXumm()) {
        r.tips = (r.tips || 0) + xrp;
        const posts = await getPosts();
        const post = posts.find((x) => x.id === postId);
        if (post) { post.assist = (post.assist || 0) + xrp; await setPosts(posts); }
        await setMap("replies", replMap);
        return j({ demo: true, credited: true });
      }
      const pay = await xumm("payload", "POST", {
        txjson: { TransactionType: "Payment", Destination: r.addr, Amount: String(Math.round(xrp * 1e6)) },
        options: { expire: 5, submit: true },
        custom_meta: { instruction: `Tip ${xrp} XRP for a reply on One Board` },
      });
      await store().setJSON(`pendingtipr/${pay.uuid}`, { postId, replyId, xrp, by: me });
      return j({ uuid: pay.uuid, qr: pay.refs.qr_png, deeplink: pay.next.always });
    }
    if (req.method === "GET" && path === "tipreply") {
      const uuid = url.searchParams.get("uuid");
      const pending = await store().get(`pendingtipr/${uuid}`, { type: "json" });
      if (!pending) return j({ error: "unknown tip" }, 404);
      const p = await xumm(`payload/${uuid}`);
      if (p.meta.expired) return j({ expired: true });
      if (!p.meta.signed) return j({ pending: true });
      if (p.response.dispatched_result !== "tesSUCCESS") return j({ failed: true, result: p.response.dispatched_result });
      if (!(await store().get(`tiprdone/${uuid}`))) {
        const replMap = await getMap("replies");
        const r = (replMap[pending.postId] || []).find((x) => x.id === pending.replyId);
        if (r) {
          r.tips = (r.tips || 0) + pending.xrp;
          await setMap("replies", replMap);
          const posts = await getPosts();
          const post = posts.find((x) => x.id === pending.postId);
          if (post) { post.assist = (post.assist || 0) + pending.xrp; await setPosts(posts); }
          const log = (await store().get("tiplog", { type: "json" })) || [];
          log.push({ addr: r.addr, xrp: pending.xrp, ts: Date.now() });
          await store().setJSON("tiplog", log.slice(-5000));
        }
        await store().set(`tiprdone/${uuid}`, "1");
      }
      return j({ credited: true, txid: p.response.txid });
    }

    /* ---------- The Ten: Harberger slots (landlord model) ----------
       Every slot is always owned — by the house (treasury) until a player buys it.
       buy    : pay the current owner their own price (house sales = platform revenue;
                player sales settle wallet to wallet). Buyer gets a 24h tax grace.
       extend : holder prepays tax at 3%/day of their self-assessed price.
                Half of every tax goes to the Golden Hour pot; half stays with the house.
       Lapsed slots revert to the house at 80% of their last price. */
    if (req.method === "POST" && (path === "slotbuy" || path === "slotextend")) {
      if (!me) return j({ error: "sign in first" }, 401);
      const body = await req.json();
      const n = Number(body.n);
      if (!(n >= 0 && n < SLOT_N)) return j({ error: "bad slot" }, 400);
      const slots = await revertSlots();
      const s = slots[n];
      const treasury = process.env.PLATFORM_WALLET;
      const posts = await getPosts();

      const price = Math.min(Math.max(Number(body.price) || 0, MIN_PRICE), MAX_PRICE);
      const days = Math.min(Math.max(Math.round(Number(body.days) || 0), 1), 30);

      let kind = path.replace("slot", ""), pend, dest, xrp, note;
      if (kind === "buy") {
        if ((s.house && me === treasury) || (!s.house && s.holder === me)) return j({ error: "already yours" }, 400);
        const post = posts.find((x) => x.id === body.postId);
        if (!post || post.addr !== me) return j({ error: "feature one of your own posts" }, 400);
        xrp = s.price; dest = s.house ? treasury : s.holder;
        pend = { kind, n, by: me, postId: post.id, text: post.text, price, house: !!s.house, pay: xrp };
        note = s.house
          ? `Buy slot #${n + 1} from the house on One Board — ${xrp} XRP`
          : `Buy out slot #${n + 1} on One Board — ${xrp} XRP straight to the current holder`;
      } else {
        if (s.house || s.holder !== me) return j({ error: "not your slot" }, 403);
        xrp = slotTax(s.price, days); dest = treasury;
        pend = { kind, n, by: me, days, tax: xrp };
        note = `Extend slot #${n + 1} on One Board — ${xrp} XRP tax for ${days} more days (half funds the Golden Hour pot)`;
      }

      const applySlot = async () => {
        const cur = await getSlots();
        const c = cur[n];
        if (pend.kind === "buy") {
          cur[n] = { n, holder: pend.by, price: pend.price, postId: pend.postId, text: pend.text, since: Date.now(), paidUntil: Math.max((!c.house && c.paidUntil) || 0, Date.now() + 864e5) };
        } else {
          c.paidUntil = Math.max(c.paidUntil || 0, Date.now()) + pend.days * 864e5;
          await addPot(+(pend.tax * POT_SHARE).toFixed(6));
        }
        await setSlots(cur);
      };

      if (!hasXumm() || !treasury || (dest === treasury && me === treasury)) {
        await applySlot();
        return j({ done: true });
      }
      const pay = await xumm("payload", "POST", {
        txjson: { TransactionType: "Payment", Destination: dest, Amount: String(Math.round(xrp * 1e6)) },
        options: { expire: 5, submit: true },
        custom_meta: { instruction: note },
      });
      await store().setJSON(`pendingslot/${pay.uuid}`, pend);
      return j({ uuid: pay.uuid, qr: pay.refs.qr_png, deeplink: pay.next.always });
    }
    if (req.method === "GET" && path === "slot") {
      const uuid = url.searchParams.get("uuid");
      const pend = await store().get(`pendingslot/${uuid}`, { type: "json" });
      if (!pend) return j({ error: "unknown slot action" }, 404);
      const p = await xumm(`payload/${uuid}`);
      if (p.meta.expired) return j({ expired: true });
      if (!p.meta.signed) return j({ pending: true });
      if (p.response.dispatched_result !== "tesSUCCESS") return j({ failed: true, result: p.response.dispatched_result });
      if (!(await store().get(`slotdone/${uuid}`))) {
        await store().set(`slotdone/${uuid}`, "1");
        const cur = await getSlots();
        const c = cur[pend.n];
        if (pend.kind === "buy") {
          cur[pend.n] = { n: pend.n, holder: pend.by, price: pend.price, postId: pend.postId, text: pend.text, since: Date.now(), paidUntil: Math.max((c && !c.house && c.paidUntil) || 0, Date.now() + 864e5) };
          await setSlots(cur);
        } else if (c && !c.house) {
          c.paidUntil = Math.max(c.paidUntil || 0, Date.now()) + pend.days * 864e5;
          await setSlots(cur); await addPot(+(pend.tax * POT_SHARE).toFixed(6));
        }
      }
      return j({ done: true });
    }

    return j({ error: "not found" }, 404);
  } catch (e) {
    return j({ error: String(e.message || e) }, 500);
  }
};
