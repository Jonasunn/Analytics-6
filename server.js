import express from "express";
import morgan from "morgan";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(morgan("dev"));

// ---- CORS ----
// Set ALLOWED_ORIGINS to a comma-separated list of origins you want to allow,
// e.g. "https://pulsmediacdn.com,https://pulsmedia.is,https://vefbordi.is"
const allowed = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowed.includes("*")) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked for origin: " + origin));
  }
}));

// ---- DB ----
// On Render, attach a Persistent Disk and set DB_PATH to that mount,
// e.g. /var/data/data.sqlite
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  create table if not exists events (
    id integer primary key autoincrement,
    received_at text not null,
    client_ts text,
    campaign_id text,
    game_id text,
    session_id text,
    anonymous_user_id text,
    event_name text not null,
    props text
  );
  create index if not exists idx_events_event_ts on events(event_name, client_ts);
  create index if not exists idx_events_campaign on events(campaign_id);
  create index if not exists idx_events_game on events(game_id);
  create index if not exists idx_events_session on events(session_id);

  create table if not exists banners (
    id integer primary key autoincrement,
    created_at text not null,
    name text not null,
    url text not null
  );
  create unique index if not exists idx_banners_url on banners(url);

  create table if not exists registrations (
    id integer primary key autoincrement,
    created_at text not null,
    session_id text,
    campaign_id text,
    game_id text,
    name text not null,
    email text not null,
    phone text not null,
    score integer,
    duration_ms integer
  );
  create index if not exists idx_regs_created on registrations(created_at);
  create index if not exists idx_regs_campaign on registrations(campaign_id);
  create index if not exists idx_regs_game on registrations(game_id);
`);

function isoNow(){ return new Date().toISOString(); }

// DEDUP: avoid double-counting banner_view on some ad/CDN environments.
// If the same (event_name, session_id) or (event_name, anonymous_user_id) arrives within DEDUP_WINDOW_MS, ignore it.
const DEDUP_WINDOW_MS = 30_000;
function shouldDropDuplicateView({ event_name, session_id, anonymous_user_id, client_ts }) {
  if (event_name !== "banner_view") return false;
  const now = Date.now();
  const ts = client_ts ? Date.parse(client_ts) : now;
  const sinceIso = new Date((isNaN(ts)? now: ts) - DEDUP_WINDOW_MS).toISOString();
  try {
    if (session_id) {
      const r = db.prepare(`select 1 as one from events where event_name=? and session_id=? and client_ts>=? limit 1`).get(event_name, session_id, sinceIso);
      if (r) return true;
    } else if (anonymous_user_id) {
      const r = db.prepare(`select 1 as one from events where event_name=? and anonymous_user_id=? and client_ts>=? limit 1`).get(event_name, anonymous_user_id, sinceIso);
      if (r) return true;
    }
  } catch {}
  return false;
}

function sanitizeShort(s, max=80){ if (s === null || s === undefined) return null; return String(s).slice(0, max); }

// 1x1 transparent gif for pixel tracking (base64)
const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

app.get("/healthz", (_req,res)=>res.json({ok:true}));
app.get("/api/version", (_req,res)=>res.json({ version: "views-dedupe-10s-v2-clicks-ui-banners" }));

app.post("/api/sessions/start", (_req,res) => {
  const sid = Math.random().toString(16).slice(2) + Date.now().toString(16);
  res.json({ session_id: sid });
});

app.post("/api/events", (req,res) => {
  const events = req.body?.events;
  if (!Array.isArray(events) || events.length > 500) return res.status(400).json({ error: "Invalid events batch" });

  const stmt = db.prepare(`
    insert into events (received_at, client_ts, campaign_id, game_id, session_id, anonymous_user_id, event_name, props)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const received = isoNow();
  const tx = db.transaction((batch) => {
    for (const e of batch) {
      if (!e || !e.event_name) continue;
      if (shouldDropDuplicateView({ event_name: String(e.event_name), session_id: e.session_id || null, anonymous_user_id: e.anonymous_user_id || null, client_ts: e.client_ts || null })) continue;
      stmt.run(
        received,
        e.client_ts || null,
        e.campaign_id || null,
        e.game_id || null,
        e.session_id || null,
        e.anonymous_user_id || null,
        String(e.event_name).slice(0, 80),
        JSON.stringify(e.props || {})
      );
    }
  });
  tx(events);
  res.json({ ok: true, ingested: events.length });
});

// Pixel endpoint (fallback when fetch is blocked by CSP/CORS)
app.get("/api/pixel.gif", (req, res) => {
  const event_name = sanitizeShort(req.query.event || req.query.event_name || "pixel");
  const campaign_id = sanitizeShort(req.query.campaign_id || null, 120);
  const game_id = sanitizeShort(req.query.game_id || null, 120);
  const session_id = sanitizeShort(req.query.session_id || null, 120);
  const anonymous_user_id = sanitizeShort(req.query.anon || req.query.anonymous_user_id || null, 120);
  const client_ts = sanitizeShort(req.query.ts || new Date().toISOString(), 60);

  if (shouldDropDuplicateView({ event_name, session_id, anonymous_user_id, client_ts })) {
    res.set("Content-Type", "image/gif");
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    return res.status(200).send(PIXEL_GIF);
  }

  const props = {
    url: sanitizeShort(req.query.url || req.get("referer") || null, 500),
    referrer: sanitizeShort(req.query.ref || null, 500),
    extra: req.query.extra ? sanitizeShort(req.query.extra, 900) : null
  };

  try {
    db.prepare(`
      insert into events (received_at, client_ts, campaign_id, game_id, session_id, anonymous_user_id, event_name, props)
      values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      isoNow(),
      client_ts,
      campaign_id,
      game_id,
      session_id,
      anonymous_user_id,
      event_name,
      JSON.stringify(props)
    );
  } catch {}

  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.status(200).send(PIXEL_GIF);
});

app.post("/api/registrations", (req,res) => {
  const { session_id, campaign_id, game_id, name, email, phone, score, duration_ms } = req.body || {};
  if (!name || !email || !phone) return res.status(400).json({ error: "Missing fields" });

  db.prepare(`
    insert into registrations (created_at, session_id, campaign_id, game_id, name, email, phone, score, duration_ms)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    isoNow(),
    session_id || null,
    campaign_id || null,
    game_id || null,
    String(name),
    String(email),
    String(phone),
    Number.isFinite(score) ? score : null,
    Number.isFinite(duration_ms) ? duration_ms : null
  );

  res.json({ ok: true });
});

app.get("/api/registrations", (req,res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const campaign = String(req.query.campaign_id || "").trim();
  const bannerUrl = String(req.query.banner_url || "").trim();
  const game = String(req.query.game_id || "").trim();

  let rows = db.prepare(`
    select id, created_at, session_id, campaign_id, game_id, name, email, phone, score, duration_ms
    from registrations
    order by datetime(created_at) desc
    limit 1000
  `).all();

  if (campaign) rows = rows.filter(r => (r.campaign_id || "") === campaign);
  if (game) rows = rows.filter(r => (r.game_id || "") === game);
  if (q) rows = rows.filter(r =>
    (r.name || "").toLowerCase().includes(q) ||
    (r.email || "").toLowerCase().includes(q) ||
    (r.phone || "").toLowerCase().includes(q)
  );

  res.json({ rows });
});

function dayKey(iso){
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const dd = String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}

app.get("/api/stats", (req,res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || "28", 10), 1), 365);
  const since = new Date(Date.now() - days*24*3600*1000).toISOString();
  const campaign = String(req.query.campaign_id || "").trim();
  const bannerUrl = String(req.query.banner_url || "").trim();
  const game = String(req.query.game_id || "").trim();

  let ev = db.prepare(`
    select event_name, client_ts, campaign_id, game_id, props
    from events
    where client_ts is not null and client_ts >= ?
  `).all(since);

  let regs = db.prepare(`
    select created_at, campaign_id, game_id
    from registrations
    where created_at >= ?
  `).all(since);

  if (campaign) {
    ev = ev.filter(x => (x.campaign_id || "") === campaign);
    regs = regs.filter(x => (x.campaign_id || "") === campaign);
  }
  if (game) {
    ev = ev.filter(x => (x.game_id || "") === game);
    regs = regs.filter(x => (x.game_id || "") === game);
  }

  if (bannerUrl) {
    ev = ev.filter(x => {
      try {
        const p = JSON.parse(x.props || "{}");
        const u = String(p.url || "");
        const ref = String(p.referrer || "");
        return u.startsWith(bannerUrl) || ref.startsWith(bannerUrl) || u.includes(bannerUrl) || ref.includes(bannerUrl);
      } catch {
        return false;
      }
    });
  }

  const byDay = new Map();
  const totals = { starts: 0, wins: 0, regs: 0, views: 0, clicks: 0 };

  const viewSeen = new Set();

  for (const r of ev) {
    const k = dayKey(r.client_ts);
    if (!byDay.has(k)) byDay.set(k, { date: k, starts: 0, wins: 0, regs: 0, views: 0, clicks: 0 });
    const o = byDay.get(k);

    if (r.event_name === "game_start" || r.event_name === "card_draw") { o.starts++; totals.starts++; }
    if (r.event_name === "win" || r.event_name === "popout_click") { o.wins++; totals.wins++; }
    if (r.event_name === "banner_click") { o.clicks++; totals.clicks++; }
    if (r.event_name === "banner_view" || r.event_name === "page_view") {
      // Dedupe views that fire twice for a single impression (common in ad/CDN iframes)
      let url = "";
      try { url = JSON.parse(r.props || "{}")?.url || ""; } catch {}
      const t = Date.parse(r.client_ts || "") || Date.now();
      const bucket = Math.floor(t / 10000); // 10-second bucket
      const key = `${k}|${r.campaign_id || ""}|${r.game_id || ""}|${url}|${bucket}`;
      if (!viewSeen.has(key)) {
        viewSeen.add(key);
        o.views++; totals.views++;
      }
    }
  }
  for (const r of regs) {
    const k = dayKey(r.created_at);
    if (!byDay.has(k)) byDay.set(k, { date: k, starts: 0, wins: 0, regs: 0, views: 0, clicks: 0 });
    byDay.get(k).regs++;
    totals.regs++;
  }

  const series = [];
  for (let i = days-1; i >= 0; i--) {
    const d = new Date(Date.now() - i*24*3600*1000);
    const k = dayKey(d.toISOString());
    series.push(byDay.get(k) || { date: k, starts: 0, wins: 0, regs: 0, views: 0, clicks: 0 });
  }

  const rates = {
    winRate: totals.starts ? totals.wins / totals.starts : 0,
    regRateFromStarts: totals.starts ? totals.regs / totals.starts : 0,
    regRateFromWins: totals.wins ? totals.regs / totals.wins : 0
  };

  const funnel = [
    { label: "Views", value: totals.views },
    { label: "Starts", value: totals.starts },
    { label: "Wins", value: totals.wins },
    { label: "Registrations", value: totals.regs }
  ];

  res.json({ totals, rates, series, funnel });
});

app.get("/api/meta", (_req,res) => {
  const campaigns = db.prepare(`select distinct campaign_id from events where campaign_id is not null and campaign_id != '' order by campaign_id`).all().map(r=>r.campaign_id);
  const games = db.prepare(`select distinct game_id from events where game_id is not null and game_id != '' order by game_id`).all().map(r=>r.game_id);
  res.json({ campaigns, games });
});

// ---- BANNERS (admin-managed list of banner URLs for easy filtering) ----
app.get("/api/banners", (_req, res) => {
  const rows = db.prepare(`select id, created_at, name, url from banners order by datetime(created_at) desc`).all();
  res.json({ rows });
});

app.post("/api/banners", (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: "Missing name or url" });
  const cleanUrl = String(url).trim();
  const cleanName = String(name).trim().slice(0, 120);
  if (!/^https?:\/\//i.test(cleanUrl)) return res.status(400).json({ error: "URL must start with http(s)://" });
  try {
    db.prepare(`insert or ignore into banners (created_at, name, url) values (?, ?, ?)`).run(isoNow(), cleanName, cleanUrl);
    const row = db.prepare(`select id, created_at, name, url from banners where url = ?`).get(cleanUrl);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ error: "Failed to save banner" });
  }
});

app.delete("/api/banners/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  db.prepare(`delete from banners where id = ?`).run(id);
  res.json({ ok: true });
});

// Dashboard UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req,res)=>res.redirect("/admin.html"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
