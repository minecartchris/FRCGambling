import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getJson } from "./fetcher.js";
import { tbaEnabled, tbaEvents } from "./tba.js";
import { sbEvents } from "./statbotics.js";
import { jevEnabled, askJev } from "./jev.js";
import { jevState, loadEvent } from "./event.js";
import { DEMO_KEY } from "./demo.js";
import { getTuning, startTuner } from "./tuner.js";
import { flushTracker, recordJev, startTracker, trackRecord } from "./tracker.js";
import { seasonHistory } from "./history.js";

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const JEV_WEIGHT = Math.min(1, Math.max(0, Number(process.env.JEV_WEIGHT ?? 0.5)));
const DEMO = { key: DEMO_KEY, name: "Demo Regional (sample data)", start: null, end: null, location: "Demo City" };

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 16_384) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

// Jev calls cost money: limit each visitor and reuse recent answers.
const hits = new Map();
function rateLimited(ip, perMinute = 30) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear();
  return list.length > perMinute;
}
const jevCache = new Map();

async function currentSeason() {
  if (tbaEnabled()) {
    try {
      const s = await getJson("https://www.thebluealliance.com/api/v3/status", { headers: { "X-TBA-Auth-Key": process.env.TBA_API_KEY }, ttlMs: 3600_000 });
      if (s.current_season) return s.current_season;
    } catch {}
  }
  return new Date().getFullYear();
}

const EVENT_KEY = /^([0-9]{4}[a-z0-9]{1,16}|demo)$/;

async function api(req, res, url) {
  const p = url.pathname;
  if (p === "/api/health") return send(res, 200, { ok: true });

  if (p === "/api/config") {
    return send(res, 200, { tba: tbaEnabled(), jev: jevEnabled(), jevWeight: JEV_WEIGHT, season: await currentSeason() });
  }

  if (p === "/api/events") {
    const year = Number(url.searchParams.get("year")) || (await currentSeason());
    try {
      const events = tbaEnabled() ? await tbaEvents(year) : await sbEvents(year);
      events.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.name.localeCompare(b.name));
      return send(res, 200, { year, events });
    } catch (err) {
      console.error("events:", err.message);
      const hint = tbaEnabled() ? "The Blue Alliance didn't respond." : "No TBA_API_KEY is set and Statbotics didn't respond.";
      return send(res, 200, { year, events: [DEMO], warning: `${hint} Showing a demo event with sample data.` });
    }
  }

  if (p === "/api/accuracy") {
    const t = getTuning();
    return send(res, 200, {
      live: trackRecord(),
      tuning: t ? { params: t.params, before: t.before, after: t.after, events: t.events, matches: t.matches, tunedAt: t.tunedAt, year: t.year } : null,
    });
  }

  const ev = p.match(/^\/api\/event\/([^/]+)$/);
  if (ev) {
    const key = decodeURIComponent(ev[1]).toLowerCase();
    if (!EVENT_KEY.test(key)) return send(res, 400, { error: "Invalid event key" });
    try {
      return send(res, 200, await loadEvent(key));
    } catch (err) {
      console.error(`event ${key}:`, err.message);
      const status = err.status === 404 ? 404 : 502;
      return send(res, status, { error: status === 404 ? "Event not found" : "Couldn't load event data right now. Try again in a minute." });
    }
  }

  if (p === "/api/jev" && req.method === "POST") {
    if (!jevEnabled()) return send(res, 400, { error: "Jev isn't configured (set JEV_API_KEY)." });
    const ip = req.headers["x-real-ip"] || req.socket.remoteAddress;
    if (rateLimited(ip)) return send(res, 429, { error: "Too many Jev requests. Wait a minute." });
    const body = await readBody(req);
    const key = String(body.event || "").toLowerCase();
    if (!EVENT_KEY.test(key)) return send(res, 400, { error: "Invalid event key" });
    const data = await loadEvent(key);
    const match = data.matches.find((m) => m.key === body.match);
    if (!match) return send(res, 404, { error: "Match not found" });
    // Jev would see the final score in the teams' results, so only ask about upcoming matches.
    if (match.played) return send(res, 400, { error: "Jev only predicts upcoming matches" });

    const bias = {};
    for (const t of [...match.red.teams, ...match.blue.teams]) {
      const v = Number(body.bias?.[t]);
      if (Number.isFinite(v) && v !== 0) bias[t] = Math.max(-100, Math.min(100, Math.round(v)));
    }
    const cacheKey = `${key}|${match.key}|${JSON.stringify(bias)}|${data.fit.playedCount}`;
    const cached = jevCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return send(res, 200, cached.value);

    const { state, stats } = jevState(data, match, bias);
    try {
      const jev = await askJev({ state, stats, sdAlliance: data.fit.sdAlliance });
      const value = { jev, weight: JEV_WEIGHT };
      if (!Object.keys(bias).length) recordJev(match.key, jev);
      jevCache.set(cacheKey, { value, expires: Date.now() + 120_000 });
      if (jevCache.size > 2000) jevCache.delete(jevCache.keys().next().value);
      return send(res, 200, value);
    } catch (err) {
      console.error("jev:", err.message);
      return send(res, 502, { error: err.name === "AbortError" ? "Jev timed out" : err.message });
    }
  }

  return send(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden");
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    // Files are tiny; always revalidate so a redeploy shows up immediately.
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  } catch {
    send(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") await serveStatic(req, res, url);
    else send(res, 405, "Method not allowed");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : "Server error" });
  }
});

await startTracker();
await startTuner(currentSeason);
if (tbaEnabled()) currentSeason().then((y) => seasonHistory(y));

server.listen(PORT, HOST, () => {
  console.log(`FRC Match Predictor on http://${HOST}:${PORT}  (TBA: ${tbaEnabled() ? "on" : "off"}, Jev: ${jevEnabled() ? "on" : "off"})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await flushTracker().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
