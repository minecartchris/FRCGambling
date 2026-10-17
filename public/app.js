import { expectedLine, overProb, predictMatch } from "/lib/model.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (p) => `${Math.round(p * 100)}%`;
const pts = (v) => (Number.isFinite(v) ? Math.round(v) : "--");
const fmt1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "--");
const rec = (r) => (r ? `${r.wins}-${r.losses}-${r.ties ?? 0}` : "--");

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  config: null,
  events: [],
  data: null,
  matchKey: null,
  bias: store.get("frc-bias", {}),
  tab: "upcoming",
  filter: "",
  sort: { key: "rank", asc: true },
  jev: {},          // cacheKey -> { status, result, error }
  refreshTimer: null,
  ou: { kind: "winning", line: null, auto: true },
  betsAll: false,
  calibSrc: null,
  accuracy: null,
};

/* ---------- boot ---------- */

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function boot() {
  buildTicks();
  wireUi();
  try {
    S.config = await api("/api/config");
  } catch {
    S.config = { tba: false, jev: false, season: new Date().getFullYear(), jevWeight: 0.5 };
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  const hashEvent = hash.get("event");
  const year = Number(hash.get("year")) || (hashEvent && /^\d{4}/.test(hashEvent) ? Number(hashEvent.slice(0, 4)) : S.config.season);
  const yearSel = $("year");
  for (let y = S.config.season; y >= 2010; y--) yearSel.add(new Option(y, y));
  yearSel.value = year;
  renderStatus();
  await loadEvents(year, hashEvent, hash.get("match"));
}

async function loadEvents(year, wantEvent, wantMatch) {
  $("eventSearch").value = "";
  $("eventSearch").placeholder = "Loading events…";
  S.events = [];
  // A linked event loads while the full event list is still coming.
  const early = wantEvent ? openEvent(wantEvent, wantMatch) : null;
  let res;
  try {
    res = await api(`/api/events?year=${year}`);
  } catch (e) {
    showBanner(e.message);
    return;
  }
  S.events = res.events;
  const list = $("eventList");
  list.innerHTML = "";
  for (const e of S.events) list.append(new Option(eventLabel(e), eventLabel(e)));
  $("eventSearch").placeholder = `Search ${S.events.length} events…`;

  if (early && (await early)) {
    const ev = S.events.find((e) => e.key === S.data.event.key);
    if (ev) $("eventSearch").value = eventLabel(ev);
    return;
  }
  if (res.warning) showBanner(res.warning);
  const pick = defaultEvent(S.events);
  if (pick) await openEvent(pick.key, wantMatch);
}

const eventLabel = (e) => `${e.name} · ${e.key}`;

function defaultEvent(events) {
  const today = new Date().toISOString().slice(0, 10);
  const live = events.find((e) => e.start && e.start <= today && today <= e.end);
  if (live) return live;
  const past = events.filter((e) => e.end && e.end < today).sort((a, b) => b.end.localeCompare(a.end));
  return past[0] || events[0];
}

async function openEvent(key, wantMatch) {
  clearTimeout(S.refreshTimer);
  const ev = S.events.find((e) => e.key === key);
  if (ev) $("eventSearch").value = eventLabel(ev);
  $("matchSelect").innerHTML = "<option>Loading…</option>";
  const seq = (S.openSeq = (S.openSeq || 0) + 1);
  let data;
  try {
    data = await api(`/api/event/${encodeURIComponent(key)}`);
  } catch (e) {
    if (seq === S.openSeq) showBanner(e.message);
    return false;
  }
  if (seq !== S.openSeq) return false; // a newer pick replaced this one
  S.data = data;
  showBanner(S.data.source === "demo" ? "Showing demo data. Set TBA_API_KEY for real events." : "");
  const ms = S.data.matches;
  const keep = ms.find((m) => m.key === wantMatch);
  S.matchKey = (keep || ms.find((m) => !m.played) || ms[ms.length - 1])?.key || null;
  S.tab = ms.some((m) => !m.played) ? "upcoming" : "completed";
  renderAll();
  scheduleRefresh();
  return true;
}

async function refreshEvent() {
  if (!S.data) return;
  try {
    const fresh = await api(`/api/event/${encodeURIComponent(S.data.event.key)}`);
    const was = S.data.matches.find((m) => m.key === S.matchKey);
    S.data = fresh;
    // If the selected match just finished, move on to the next upcoming one.
    const now = fresh.matches.find((m) => m.key === S.matchKey);
    if (was && now && !was.played && now.played) S.matchKey = (fresh.matches.find((m) => !m.played) || now).key;
    renderAll();
  } catch {}
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(S.refreshTimer);
  if (S.data?.live) S.refreshTimer = setTimeout(refreshEvent, 60_000);
}

/* ---------- predictions ---------- */

const matchOf = (key) => S.data?.matches.find((m) => m.key === key);
const teamOf = (id) => S.data?.teams.find((t) => t.id === id);
const predict = (m) => predictMatch(m, S.data.fit, { bias: S.bias, form: S.data.form, opts: S.data.opts });

function biasFor(m) {
  const b = {};
  for (const t of [...m.red.teams, ...m.blue.teams]) if (S.bias[t]) b[t] = S.bias[t];
  return b;
}
const jevKey = (m) => `${S.data.event.key}|${m.key}|${JSON.stringify(biasFor(m))}|${S.data.fit.playedCount}`;

let jevTimer;
function requestJev(m) {
  if (!S.config.jev || !m || m.played) return;
  const k = jevKey(m);
  if (S.jev[k]) return;
  clearTimeout(jevTimer);
  jevTimer = setTimeout(async () => {
    S.jev[k] = { status: "loading" };
    renderHero();
    try {
      const r = await api("/api/jev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: S.data.event.key, match: m.key, bias: biasFor(m) }),
      });
      S.jev[k] = { status: "done", result: r.jev, weight: r.weight };
    } catch (e) {
      S.jev[k] = { status: "error", error: e.message };
    }
    if (S.matchKey === m.key) renderHero();
  }, 450);
}

function combined(m) {
  const stats = predict(m);
  const j = S.config.jev ? S.jev[jevKey(m)] : null;
  if (j?.status !== "done") return { stats, jev: j, final: stats };
  const w = j.weight ?? S.config.jevWeight ?? 0.5;
  const red = (1 - w) * stats.redWinProb + w * j.result.redWinProb;
  const winning = Number.isFinite(j.result.winningScore) ? (1 - w) * stats.winningScore + w * j.result.winningScore : stats.winningScore;
  const shift = winning - stats.winningScore;
  return {
    stats,
    jev: j,
    final: { ...stats, redWinProb: red, blueWinProb: 1 - red, winner: red >= 0.5 ? "red" : "blue", winningScore: winning, winningScoreRange: stats.winningScoreRange.map((v) => v + shift) },
  };
}

/* ---------- rendering ---------- */

function renderAll() {
  renderStatus();
  renderMatchSelect();
  renderHero();
  renderAlliances();
  renderMatches();
  renderAccuracy();
  renderTeams();
  renderBets();
  renderCalibration();
  loadAccuracy();
  updateHash();
}

function renderStatus() {
  const d = S.data;
  const c = S.config || {};
  const src = d ? { tba: "The Blue Alliance", statbotics: "Statbotics", demo: "Demo data" }[d.source] : c.tba ? "The Blue Alliance" : "Statbotics";
  const pills = [
    `<span class="pill ${d?.source === "demo" ? "off" : "on"}" title="Schedule and score source">${esc(src)}</span>`,
    (() => {
      const c = d?.priorCounts;
      const on = c && c.epa + c.history > 0;
      const title = c ? `Starting ratings: ${c.epa} from Statbotics EPA, ${c.history} from earlier events, ${c.none} with none` : "Historical team ratings";
      return `<span class="pill ${on ? "on" : "off"}" title="${esc(title)}">Team history</span>`;
    })(),
    `<span class="pill ${c.jev ? "on" : "off"}" title="${c.jev ? "Jev AI is blended into predictions" : "Set JEV_API_KEY to enable Jev"}">Jev AI</span>`,
  ];
  if (d?.live) pills.unshift(`<span class="pill live">Live</span>`);
  $("status").innerHTML = pills.join("");
}

function renderMatchSelect() {
  const sel = $("matchSelect");
  sel.innerHTML = "";
  for (const m of S.data.matches) sel.add(new Option(`${m.label}${m.played ? " ✓" : ""}`, m.key));
  sel.value = S.matchKey;
  const i = S.data.matches.findIndex((m) => m.key === S.matchKey);
  $("prevMatch").disabled = i <= 0;
  $("nextMatch").disabled = i < 0 || i >= S.data.matches.length - 1;
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return "";
  return new Date(t * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function setGauge(redProb) {
  const blue = 1 - redProb;
  $("needle").style.transform = `rotate(${(blue * 180).toFixed(2)}deg)`;
  $("redPct").textContent = pct(redProb);
  $("bluePct").textContent = pct(blue);
}

function buildTicks() {
  const g = $("gaugeTicks");
  let html = "";
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const a = Math.PI * (1 - f);
    const x1 = 160 + Math.cos(a) * 106, y1 = 160 - Math.sin(a) * 106;
    const x2 = 160 + Math.cos(a) * 134, y2 = 160 - Math.sin(a) * 134;
    if (f > 0 && f < 1) html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  g.innerHTML = html + `<text x="160" y="16">50 / 50</text>`;
}

function renderHero() {
  const m = matchOf(S.matchKey);
  if (!m || !S.data.fit.hasData) {
    setGauge(0.5);
    $("verdict").textContent = m ? "Not enough data yet to predict this event." : "No matches scheduled yet.";
    ["redScore", "blueScore", "winScore"].forEach((id) => ($(id).textContent = "--"));
    $("winRange").textContent = "";
    $("models").innerHTML = "";
    $("actual").hidden = true;
    $("matchMeta").textContent = S.data?.event.name || "";
    renderOU();
    return;
  }
  const { stats, jev, final } = combined(m);
  setGauge(final.redWinProb);

  const meta = [`<span>${esc(S.data.event.name)}</span>`];
  if (m.time) meta.push(`<span>${esc(fmtTime(m.time))}</span>`);
  if (m.elim) meta.push(`<span class="chip">Playoff</span>`);
  if (m.played && m.latestDay && S.data.live) meta.push(`<span class="chip today">Today</span>`);
  $("matchMeta").innerHTML = meta.join("");

  const fav = final.winner;
  const p = Math.max(final.redWinProb, final.blueWinProb);
  const strength = p > 0.8 ? "strong favorite" : p > 0.62 ? "favored" : p > 0.54 ? "slight edge" : "toss-up";
  $("verdict").innerHTML = strength === "toss-up"
    ? `Too close to call: <b class="${fav}">${fav === "red" ? "Red" : "Blue"}</b> by a hair`
    : `<b class="${fav}">${fav === "red" ? "Red" : "Blue"}</b> ${strength}, ${pct(p)} to win`;

  $("redScore").textContent = pts(stats.redScore);
  $("blueScore").textContent = pts(stats.blueScore);
  $("winScore").textContent = pts(final.winningScore);
  const miss = S.data.accuracy?.scoreError;
  $("winRange").textContent = `${fav === "red" ? "Red" : "Blue"} · likely ${pts(final.winningScoreRange[0])}–${pts(final.winningScoreRange[1])}${Number.isFinite(miss) ? ` · avg miss here ±${Math.round(miss)}` : ""}`;

  const card = (name, red, extra = "", main = false) => `
    <div class="model${main ? " main" : ""}">
      <span class="m-name"><span>${name}</span><span>${extra}</span></span>
      <span class="m-val">Red ${pct(red)} · Blue ${pct(1 - red)}</span>
      <span class="split"><span class="r" style="width:${red * 100}%"></span><span class="b" style="width:${(1 - red) * 100}%"></span></span>
    </div>`;
  let html = card("Stats model", stats.redWinProb, `win score ${pts(stats.winningScore)}`, !S.config.jev);
  if (S.config.jev) {
    if (m.played) html += `<div class="model"><span class="m-name">Jev AI</span><span class="m-val skeleton">Runs on upcoming matches</span></div>`;
    else if (!jev || jev.status === "loading") html += `<div class="model"><span class="m-name">Jev AI</span><span class="m-val skeleton">Asking Jev…</span></div>`;
    else if (jev.status === "error") html += `<div class="model"><span class="m-name">Jev AI</span><span class="m-err">${esc(jev.error)}</span></div>`;
    else {
      const conf = Number.isFinite(jev.result.confidence) ? `conf ${pct(jev.result.confidence)}` : "";
      html += card("Jev AI", jev.result.redWinProb, conf);
      html += card(`Blended (${pct(1 - jev.weight)} stats / ${pct(jev.weight)} Jev)`, final.redWinProb, "", true);
    }
  }
  $("models").innerHTML = html;

  const act = $("actual");
  if (m.played) {
    const w = m.red.score > m.blue.score ? "red" : m.red.score < m.blue.score ? "blue" : "tie";
    const pre = m.pre;
    let verdict = "";
    if (pre && w !== "tie") {
      const ok = (pre.redWinProb >= 0.5) === (w === "red");
      verdict = ` · Pre-match pick: ${pre.redWinProb >= 0.5 ? "Red" : "Blue"} ${pct(Math.max(pre.redWinProb, 1 - pre.redWinProb))} <span class="${ok ? "ok" : "miss"}">${ok ? "✓ correct" : "✗ upset"}</span>`;
    }
    act.innerHTML = `Final: <b style="color:var(--red)">${m.red.score}</b> – <b style="color:var(--blue)">${m.blue.score}</b> ${w === "tie" ? "Tie" : `${w === "red" ? "Red" : "Blue"} won`}${verdict}`;
    act.hidden = false;
  } else act.hidden = true;

  renderOU();
  requestJev(m);
}

function formChips(history, n = 5) {
  return `<span class="form">${history.slice(-n).map((h) => `<i class="${h.result}${h.latestDay && S.data.live ? " today" : ""}" title="${esc(h.label)}: ${h.score}-${h.opp}">${h.result}</i>`).join("")}</span>`;
}

function trend(t) {
  if (!Number.isFinite(t.rating) || !Number.isFinite(t.prior) || !t.history.length) return "";
  const d = t.rating - t.prior;
  if (Math.abs(d) < 0.5) return `<span>±0</span>`;
  return `<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}</span>`;
}

function renderAlliances() {
  const m = matchOf(S.matchKey);
  const pred = m && S.data.fit.hasData ? predict(m) : null;
  for (const side of ["red", "blue"]) {
    const el = $(`${side}Teams`);
    if (!m) { el.innerHTML = `<div class="empty">No match selected</div>`; continue; }
    el.innerHTML = m[side].teams.map((id) => {
      const t = teamOf(id) || { id, name: `Team ${id}`, history: [] };
      const b = S.bias[id] || 0;
      return `
      <div class="tcard">
        <div class="tcard-top">
          <button class="tnum" data-team="${esc(id)}">${esc(id)}</button>
          <span class="tname">${esc(t.name)}</span>
          <span class="tpts" title="Expected points this match">${pred ? fmt1(pred.teamPoints[id]) : "--"} pts</span>
        </div>
        <div class="tstats">
          <span>Rank <b>${t.rank ?? "--"}</b></span>
          <span>Event <b>${rec(t.record)}</b></span>
          ${t.season?.epa ? `<span>Season EPA <b>${fmt1(t.season.epa.total)}</b></span>` : t.priorSource === "history" ? `<span title="Points per match at earlier events this season">Earlier events <b>${fmt1(t.prior)}</b></span>` : ""}
          ${trend(t)}
          ${t.history?.length ? formChips(t.history) : ""}
        </div>
        <label class="bias">
          <span>Bias</span>
          <input type="range" min="-100" max="100" step="5" value="${b}" data-bias="${esc(id)}" aria-label="Bias for team ${esc(id)}">
          <output>${b > 0 ? "+" : ""}${b}</output>
        </label>
      </div>`;
    }).join("");
  }
}

function matchRow(m) {
  const filt = S.filter;
  const teamCell = (side) => `<span class="tl">${m[side].teams.map((t) => `<span class="${filt && t === filt ? "hl" : ""}">${esc(t)}</span>`).join("")}</span>`;
  let predCell = "";
  if (S.data.fit.hasData) {
    const p = m.played && m.pre ? m.pre.redWinProb : predict(m).redWinProb;
    const fav = p >= 0.5 ? "Red" : "Blue";
    const mark = m.played && m.pre && m.pre.correct !== null ? (m.pre.correct ? ` <span class="ok">✓</span>` : ` <span class="miss">✗</span>`) : "";
    predCell = `<span class="pred"><span class="split"><span class="r" style="width:${p * 100}%"></span><span class="b" style="width:${(1 - p) * 100}%"></span></span>${fav} ${pct(Math.max(p, 1 - p))}${mark}</span>`;
  }
  let res = "";
  if (m.played) {
    const rw = m.red.score > m.blue.score, bw = m.blue.score > m.red.score;
    res = `<span class="res"><span class="red ${rw ? "w" : ""}">${m.red.score}</span> – <span class="blue ${bw ? "w" : ""}">${m.blue.score}</span></span>`;
  } else {
    const p = predict(m);
    res = `<span class="res" title="Predicted score" style="color:var(--muted)">${pts(p.redScore)} – ${pts(p.blueScore)}</span>`;
  }
  const today = m.played && m.latestDay && S.data.live ? ` <span class="chip today">Today</span>` : "";
  return `<tr data-match="${esc(m.key)}" class="${m.key === S.matchKey ? "selected" : ""}">
    <td>${esc(m.label)}${today}</td>
    <td class="hide-sm">${esc(fmtTime(m.time))}</td>
    <td class="r">${teamCell("red")}</td>
    <td class="b">${teamCell("blue")}</td>
    <td>${predCell}</td>
    <td>${res}</td>
  </tr>`;
}

function renderMatches() {
  document.querySelectorAll("#matchTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  let ms = S.data.matches;
  if (S.tab === "upcoming") ms = ms.filter((m) => !m.played);
  if (S.tab === "completed") ms = ms.filter((m) => m.played).slice().reverse();
  if (S.filter) ms = ms.filter((m) => m.red.teams.includes(S.filter) || m.blue.teams.includes(S.filter));
  $("matchRows").innerHTML = ms.length ? ms.map(matchRow).join("") : `<tr><td colspan="6" class="empty">${S.tab === "upcoming" ? "No upcoming matches" : "No matches"}${S.filter ? ` for team ${esc(S.filter)}` : ""}</td></tr>`;
}

/* ---------- over / under ---------- */

const NICE = [1, 2, 5, 10, 20, 25, 50, 100];
const niceStep = (x) => NICE.find((s) => s >= x) || 100;
const OU_NAMES = { winning: "winning score", red: "Red's score", blue: "Blue's score", total: "total points" };

function actualFor(m, kind) {
  if (kind === "red") return m.red.score;
  if (kind === "blue") return m.blue.score;
  if (kind === "total") return m.red.score + m.blue.score;
  return Math.max(m.red.score, m.blue.score);
}

function renderOU() {
  const m = matchOf(S.matchKey);
  const box = $("ou");
  if (!m || !S.data?.fit.hasData) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const p = predict(m);
  const { kind } = S.ou;
  document.querySelectorAll("#ouKind button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.kind === kind)));
  const exp = expectedLine(p, kind);
  const spread = kind === "total" ? p.sd * Math.SQRT2 : p.sd;
  const step = niceStep(spread / 4);
  // Half-point lines, like a sportsbook, so there's never a push.
  const base = Math.floor(exp) + 0.5;
  if (S.ou.auto || S.ou.line == null) S.ou.line = base;
  S.ou.step = step;
  const line = S.ou.line;
  const over = overProb(p, kind, line);
  $("ouLine").value = line;
  $("ouOver").textContent = pct(over);
  $("ouUnder").textContent = pct(1 - over);

  const tableStep = niceStep(spread / 2);
  $("ouLines").innerHTML = [-2, -1, 0, 1, 2]
    .map((k) => {
      const l = base + k * tableStep;
      const o = overProb(p, kind, l);
      return `<button class="ou-row${l === line ? " on" : ""}" data-line="${l}">
        <span class="ou-l">${l}</span>
        <span class="ou-bar"><span style="width:${o * 100}%"></span></span>
        <span class="ou-p">O ${pct(o)} · U ${pct(1 - o)}</span>
      </button>`;
    })
    .join("");

  const hit = S.accuracy?.tuning?.after?.rangeHit ?? S.data.accuracy?.rangeHit;
  let note = `Chance the ${OU_NAMES[kind]} goes over or under the line. Expected ${pts(exp)}. Stats model, including your bias.`;
  if (Number.isFinite(hit)) note += ` Checked against real results: ${pct(hit)} of scores land in the model's 80% range.`;
  if (m.played) {
    const a = actualFor(m, kind);
    note = `Final ${OU_NAMES[kind]}: <b>${a}</b>, which went <b>${a > line ? "over" : "under"}</b> ${line}. ` + note;
  }
  $("ouNote").innerHTML = note;
}

/* ---------- best bets ---------- */

const TIERS = [
  { lo: 0.8, name: "Lock", cls: "lock" },
  { lo: 0.7, name: "Strong", cls: "strong" },
  { lo: 0.6, name: "Lean", cls: "lean" },
  { lo: 0, name: "Toss-up", cls: "toss" },
];
const tierOf = (f) => TIERS.find((t) => f >= t.lo);

// How often picks at this confidence actually won (recent events, else this event).
function tierRecord(tier) {
  const recent = S.accuracy?.tuning?.after?.calibration;
  const bins = recent || S.data.accuracy?.calibration;
  if (!bins) return null;
  const where = recent ? "recently" : "at this event";
  const hi = TIERS[TIERS.indexOf(tier) - 1]?.lo ?? 1.01;
  const inTier = bins.filter((b) => b.lo >= Math.max(0.5, tier.lo) && b.lo < hi);
  const n = inTier.reduce((s, b) => s + b.n, 0);
  const wins = inTier.reduce((s, b) => s + (b.actual ?? 0) * b.n, 0);
  return n >= 10 ? { n, rate: wins / n, where } : null;
}

function renderBets() {
  const list = $("betsList");
  const more = $("betsMore");
  const ups = S.data.fit.hasData ? S.data.matches.filter((m) => !m.played) : [];
  if (!ups.length) {
    list.innerHTML = `<div class="empty">No upcoming matches at this event.</div>`;
    more.hidden = true;
    $("betsSub").textContent = "";
    return;
  }
  const rows = ups
    .map((m) => {
      const p = predict(m);
      return { m, p, fav: Math.max(p.redWinProb, p.blueWinProb) };
    })
    .sort((a, b) => b.fav - a.fav);
  const shown = S.betsAll ? rows : rows.slice(0, 6);
  list.innerHTML = shown
    .map(({ m, p, fav }) => {
      const tier = tierOf(fav);
      const rec = tierRecord(tier);
      const side = p.winner;
      const ou = Math.round(p.winningScore) + 0.5;
      return `<button class="bet" data-match="${esc(m.key)}">
        <span class="tier ${tier.cls}" title="${rec ? `Picks like this won ${pct(rec.rate)} of ${rec.n} matches ${rec.where}` : ""}">${tier.name}</span>
        <span class="bet-match"><b>${esc(m.label)}</b><span>${esc(fmtTime(m.time))}</span></span>
        <span class="bet-pick ${side}"><b>${side === "red" ? "Red" : "Blue"} ${pct(fav)}</b><span>${m[side].teams.map(esc).join(" · ")}</span></span>
        <span class="bet-rec">${rec ? `${tier.name} picks won ${pct(rec.rate)} ${rec.where}` : ""}</span>
        <span class="bet-ou">Win score O/U <b>${ou}</b></span>
      </button>`;
    })
    .join("");
  more.hidden = rows.length <= 6;
  more.textContent = S.betsAll ? "Show top 6" : `Show all ${rows.length} upcoming`;
  $("betsSub").textContent = "Most confident first · stats model + your bias";
}

/* ---------- calibration chart ---------- */

function calibSources() {
  const out = [];
  const t = S.accuracy?.tuning;
  const live = S.accuracy?.live?.overall;
  const has = (bins) => bins && bins.some((b) => b.n > 0);
  if (has(S.data?.accuracy?.calibration)) out.push({ id: "event", label: "This event", bins: S.data.accuracy.calibration });
  if (has(t?.after?.calibration)) out.push({ id: "recent", label: `Last ${t.events} events`, bins: t.after.calibration });
  if (has(live?.calibration)) out.push({ id: "live", label: "Live", bins: live.calibration });
  if (has(live?.jev?.calibration)) out.push({ id: "jev", label: "Live Jev", bins: live.jev.calibration });
  return out;
}

function renderCalibration() {
  const sources = calibSources();
  const chart = $("calibChart");
  if (!sources.length) {
    $("calibSource").innerHTML = "";
    chart.innerHTML = `<div class="empty">Shows up after a few matches are played.</div>`;
    $("calibTable").innerHTML = "";
    return;
  }
  // Default to the biggest sample (recent events) until the viewer picks a tab.
  if (!S.calibPicked || !sources.some((s) => s.id === S.calibSrc)) S.calibSrc = (sources.find((s) => s.id === "recent") || sources[0]).id;
  const src = sources.find((s) => s.id === S.calibSrc);
  $("calibSource").innerHTML = sources.map((s) => `<button role="tab" data-src="${s.id}" aria-selected="${s.id === src.id}">${esc(s.label)}</button>`).join("");

  const W = 300, H = 230, L = 40, R = 290, T = 12, B = 190;
  const x = (v) => L + ((v - 0.5) / 0.5) * (R - L);
  const y = (v) => B - ((v - 0.3) / 0.7) * (B - T);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted chance versus how often favorites actually won">`;
  for (const g of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) svg += `<line class="grid" x1="${L}" x2="${R}" y1="${y(g)}" y2="${y(g)}"/><text class="tick" x="${L - 6}" y="${y(g) + 3}" text-anchor="end">${Math.round(g * 100)}%</text>`;
  for (const g of [0.5, 0.6, 0.7, 0.8, 0.9, 1]) svg += `<text class="tick" x="${x(g)}" y="${B + 14}" text-anchor="middle">${Math.round(g * 100)}%</text>`;
  svg += `<line class="ideal" x1="${x(0.5)}" y1="${y(0.5)}" x2="${x(1)}" y2="${y(1)}"/>`;
  svg += `<text class="axis" x="${(L + R) / 2}" y="${H - 6}" text-anchor="middle">Predicted chance for the favorite</text>`;
  svg += `<text class="axis" transform="translate(11 ${(T + B) / 2}) rotate(-90)" text-anchor="middle">Actually won</text>`;
  src.bins.forEach((b, i) => {
    if (!b.n) return;
    const cx = x(b.predicted), cy = y(Math.max(0.3, b.actual));
    svg += `<line class="gap" x1="${cx}" x2="${cx}" y1="${y(b.predicted)}" y2="${cy}"/>`;
    svg += `<circle class="dot${b.n < 10 ? " few" : ""}" cx="${cx}" cy="${cy}" r="5"/>`;
    svg += `<circle class="hit" data-bin="${i}" cx="${cx}" cy="${cy}" r="14"/>`;
  });
  svg += `</svg><div class="tip" id="calibTip" hidden></div>`;
  chart.innerHTML = svg;

  const tip = $("calibTip");
  chart.querySelectorAll(".hit").forEach((c) => {
    const b = src.bins[Number(c.dataset.bin)];
    const show = () => {
      tip.innerHTML = `<b>${Math.round(b.lo * 100)}–${Math.round(Math.min(1, b.hi) * 100)}% favorites</b><br>Predicted ${pct(b.predicted)} · won ${pct(b.actual)}<br>${b.n} matches${b.n < 10 ? " (too few to judge)" : ""}`;
      tip.hidden = false;
      const box = chart.getBoundingClientRect();
      const r = c.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - 170, Math.max(0, r.left - box.left - 70))}px`;
      tip.style.top = `${r.top - box.top - 64}px`;
    };
    c.addEventListener("pointerenter", show);
    c.addEventListener("pointerleave", () => (tip.hidden = true));
    c.addEventListener("click", show);
  });

  $("calibTable").innerHTML = `<table><thead><tr><th>Favorite's chance</th><th>Predicted</th><th>Won</th><th>Matches</th></tr></thead><tbody>${src.bins
    .map((b) => `<tr><td>${Math.round(b.lo * 100)}–${Math.round(Math.min(1, b.hi) * 100)}%</td><td>${b.n ? pct(b.predicted) : "--"}</td><td>${b.n ? pct(b.actual) : "--"}</td><td>${b.n}</td></tr>`)
    .join("")}</tbody></table>`;
}

const GOAL = 25;

const meter = (label, frac, note = "") => `
  <div class="meter">
    <div class="meter-top"><span>${label}</span><b>${frac == null ? "--" : pct(frac)}</b></div>
    <div class="meter-track"><span style="width:${(frac || 0) * 100}%"></span></div>
    ${note ? `<div class="meter-note">${note}</div>` : ""}
  </div>`;

function stageBars(byThird) {
  if (!byThird || byThird.some((v) => v == null)) return "";
  const max = Math.max(...byThird, GOAL);
  const names = ["Early", "Middle", "Late"];
  return `<div class="stages" title="Average score miss in each third of the event">
    ${byThird.map((v, i) => `<div class="stage"><span class="stage-bar" style="height:${(v / max) * 100}%"></span><b>±${Math.round(v)}</b><span>${names[i]}</span></div>`).join("")}
    <div class="stage-goal" style="bottom:${(GOAL / max) * 100}%"><span>±${GOAL} goal</span></div>
  </div>`;
}

function priorNote() {
  const c = S.data.priorCounts;
  if (!c) return "";
  const parts = [];
  if (c.epa) parts.push(`${c.epa} from Statbotics EPA`);
  if (c.history) parts.push(`${c.history} from earlier events this season`);
  if (c.none) parts.push(`${c.none} with no history`);
  return `Starting ratings: ${parts.join(", ")}.`;
}

function renderAccuracy() {
  const a = S.data.accuracy;
  const f = S.data.fit;
  const latest = f.latestDayCount;
  $("accuracy").innerHTML = `
    <h2>Score accuracy at this event</h2>
    ${a.scored ? `
    <div class="headline"><span class="big">±${Math.round(a.scoreError)}</span><span>avg score miss per alliance (goal ±${GOAL})</span></div>
    ${meter(`Within ±${GOAL} pts`, a.within25)}
    ${meter("Within ±5 pts", a.within5)}
    ${stageBars(a.byThird)}
    <div class="stat-grid">
      <div class="stat"><div class="v">${pct(a.accuracy)}</div><div class="k">winners picked (${a.matches})</div></div>
      <div class="stat"><div class="v">±${Math.round(a.winScoreError)}</div><div class="k">winning-score miss</div></div>
      <div class="stat"><div class="v">${a.brier.toFixed(3)}</div><div class="k">Brier (0.25 = coin flip)</div></div>
      <div class="stat"><div class="v">${pts(f.avgAlliance)}</div><div class="k">avg alliance score</div></div>
    </div>
    <p class="note">Each completed match was re-predicted using only what was known before it. ${f.playedCount} results feed the current ratings${latest ? `, with the ${S.data.live ? "current" : "last"} day of play weighted most` : ""}. ${priorNote()}</p>`
      : `<p class="note">No completed matches yet. ${priorNote()}</p>`}`;
}

function renderSeason() {
  const el = $("season");
  const acc = S.accuracy;
  if (!acc) { el.hidden = true; return; }
  el.hidden = false;
  const o = acc.live.overall;
  const t = acc.tuning;
  const trend = acc.live.trend;
  let html = `<h2>Live track record</h2>`;
  if (o.scored) {
    html += `
      <div class="headline"><span class="big">±${Math.round(o.scoreError)}</span><span>avg miss over ${o.scored} graded matches</span></div>
      ${meter(`Within ±${GOAL} pts`, o.within25)}
      <div class="stat-grid">
        <div class="stat"><div class="v">${pct(o.accuracy)}</div><div class="k">winners picked</div></div>
        <div class="stat"><div class="v">${o.jev ? pct(o.jev.accuracy) : "--"}</div><div class="k">Jev winners${o.jev ? ` (${o.jev.matches})` : ""}</div></div>
      </div>
      ${trend ? `<p class="note">Getting better? Older half ±${Math.round(trend.older)} → newer half ±${Math.round(trend.newer)} pts.</p>` : ""}`;
  } else {
    html += `<p class="note">Each match's last prediction before it's played is saved and graded once the score posts. ${acc.live.pending ? `${acc.live.pending} predictions waiting for results.` : "Nothing graded yet. Open a live event to start."}</p>`;
  }
  if (t) {
    html += `<p class="note"><b>Auto-tuned</b> on ${t.events} recent events (${t.matches.toLocaleString()} matches), ${new Date(t.tunedAt).toLocaleDateString()}: avg miss ±${fmt1(t.before.scoreError)} → ±${fmt1(t.after.scoreError)} pts, within ±${GOAL} ${pct(t.before.within25)} → ${pct(t.after.within25)}.</p>`;
  } else if (S.config.tba) {
    html += `<p class="note">Auto-tuning runs in the background after startup.</p>`;
  }
  el.innerHTML = html;
}

async function loadAccuracy() {
  try {
    S.accuracy = await api("/api/accuracy");
  } catch {
    S.accuracy = null;
  }
  renderSeason();
  if (S.data) {
    renderCalibration();
    renderBets();
    renderOU();
  }
}

function teamSortVal(t, key) {
  switch (key) {
    case "rank": return t.rank ?? 9999;
    case "id": return Number(t.id);
    case "wins": return -(t.record?.wins ?? 0);
    case "rating": return -(t.rating ?? -999);
    case "delta": return -((t.rating ?? 0) - (t.prior ?? 0));
    case "epa": return -(t.season?.epa?.total ?? -999);
    case "winrate": return -(t.season?.record?.winrate ?? -1);
    case "bias": return -(S.bias[t.id] || 0);
  }
  return 0;
}

function renderTeams() {
  const { key, asc } = S.sort;
  const rows = [...S.data.teams].sort((a, b) => (teamSortVal(a, key) - teamSortVal(b, key)) * (asc ? 1 : -1) || Number(a.id) - Number(b.id));
  document.querySelectorAll(".team-table th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    th.classList.toggle("asc", th.dataset.sort === key && !asc);
  });
  $("teamRows").innerHTML = rows.map((t) => {
    const b = S.bias[t.id] || 0;
    return `<tr data-team="${esc(t.id)}">
      <td>${t.rank ?? "--"}</td>
      <td><b>${esc(t.id)}</b> <span style="color:var(--muted)">${esc(t.name)}</span></td>
      <td>${rec(t.record)}</td>
      <td>${fmt1(t.rating)}</td>
      <td class="hide-sm">${trend(t) || "--"}</td>
      <td class="hide-sm">${fmt1(t.season?.epa?.total)}</td>
      <td class="hide-sm">${t.season?.record ? rec(t.season.record) : "--"}</td>
      <td class="bias-val ${b > 0 ? "pos" : b < 0 ? "neg" : ""}">${b ? (b > 0 ? "+" : "") + b : "0"}</td>
    </tr>`;
  }).join("");
}

function spark(history) {
  if (history.length < 2) return "";
  const W = 560, H = 60, pad = 6;
  const vals = history.map((h) => h.score);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (i) => pad + (i * (W - 2 * pad)) / (history.length - 1);
  const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const pts = history.map((h, i) => `${x(i).toFixed(1)},${y(h.score).toFixed(1)}`).join(" ");
  const dots = history.map((h, i) => `<circle class="${h.result}" cx="${x(i).toFixed(1)}" cy="${y(h.score).toFixed(1)}" r="3.5"><title>${esc(h.label)}: ${h.score}-${h.opp} ${h.result}</title></circle>`).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}"/>${dots}</svg>`;
}

function openTeam(id) {
  const t = teamOf(id);
  if (!t) return;
  const se = t.season?.epa;
  const max = Math.max(se?.auto || 0, se?.teleop || 0, se?.endgame || 0, 1);
  const bar = (label, v) => `<div class="bar"><span>${label}</span><span class="track"><span class="fill" style="width:${Math.max(0, (v / max) * 100)}%"></span></span><span class="val">${fmt1(v)}</span></div>`;
  const upcoming = S.data.matches.filter((m) => !m.played && (m.red.teams.includes(id) || m.blue.teams.includes(id)));
  const b = S.bias[id] || 0;

  $("teamDetail").innerHTML = `
    <div class="d-head">
      <div><h3>${esc(id)} · ${esc(t.name)}</h3><p>${esc(t.location)}</p></div>
      <button class="icon-btn" data-close aria-label="Close">×</button>
    </div>
    <div class="d-section">
      <h4>At this event</h4>
      <div class="d-grid">
        <div class="stat"><div class="v">${t.rank ?? "--"}</div><div class="k">rank</div></div>
        <div class="stat"><div class="v">${rec(t.record)}</div><div class="k">W-L-T</div></div>
        <div class="stat"><div class="v">${fmt1(t.rating)}</div><div class="k">rating now (pts)</div></div>
        <div class="stat"><div class="v">${fmt1(t.prior)}</div><div class="k">entering event${{ epa: " (EPA)", history: " (earlier events)" }[t.priorSource] || " (no history)"}</div></div>
        <div class="stat"><div class="v">${fmt1(t.avgScore)}</div><div class="k">avg alliance score</div></div>
      </div>
      ${spark(t.history)}
    </div>
    <div class="d-section">
      <h4>Season history${se?.percentile != null ? ` · top ${Math.max(1, Math.round((1 - se.percentile) * 100))}% of teams` : ""}</h4>
      ${se ? `<div class="d-grid" style="margin-bottom:10px">
        <div class="stat"><div class="v">${fmt1(se.total)}</div><div class="k">season EPA</div></div>
        <div class="stat"><div class="v">${rec(t.season.record)}</div><div class="k">season W-L-T</div></div>
        <div class="stat"><div class="v">${t.season.record?.winrate != null ? pct(t.season.record.winrate) : "--"}</div><div class="k">season win rate</div></div>
        <div class="stat"><div class="v">${fmt1(t.lastSeason?.epa?.total)}</div><div class="k">last season EPA</div></div>
      </div>
      <div class="bars">${bar("Auto", se.auto)}${bar("Teleop", se.teleop)}${bar("Endgame", se.endgame)}</div>` : `<p class="note">No Statbotics history available.</p>`}
    </div>
    ${t.pastEvents?.length ? `<div class="d-section">
      <h4>Earlier events this season (OPR)</h4>
      <div class="d-list">${t.pastEvents.slice().reverse().map((e) => `<div class="d-row static"><span>${esc(e.event)}</span><span></span><span>${fmt1(e.opr)} pts</span></div>`).join("")}</div>
    </div>` : ""}
    <div class="d-section">
      <h4>Your bias</h4>
      <label class="bias"><span>Bias</span><input type="range" min="-100" max="100" step="5" value="${b}" data-bias="${esc(id)}"><output>${b > 0 ? "+" : ""}${b}</output></label>
    </div>
    ${upcoming.length ? `<div class="d-section"><h4>Upcoming</h4><div class="d-list">${upcoming.map((m) => {
      const p = predict(m);
      const side = m.red.teams.includes(id) ? "red" : "blue";
      const wp = side === "red" ? p.redWinProb : p.blueWinProb;
      return `<button class="d-row" data-match="${esc(m.key)}"><span>${esc(m.label)}</span><span style="color:var(--${side})">${side === "red" ? "Red" : "Blue"} alliance</span><span>${pct(wp)} to win</span></button>`;
    }).join("")}</div></div>` : ""}
    ${t.history.length ? `<div class="d-section"><h4>Results here</h4><div class="d-list">${t.history.slice().reverse().map((h) => `
      <button class="d-row" data-match="${esc(h.key)}"><span>${esc(h.label)}</span><span style="color:var(--${h.alliance})">${h.score} – ${h.opp}</span><span class="${h.result === "W" ? "ok" : h.result === "L" ? "miss" : ""}">${h.result}</span></button>`).join("")}</div></div>` : ""}
  `;
  const dlg = $("teamDialog");
  if (!dlg.open) dlg.showModal();
}

/* ---------- interaction ---------- */

function selectMatch(key, scroll = true) {
  S.matchKey = key;
  S.ou.auto = true;
  renderMatchSelect();
  renderHero();
  renderAlliances();
  document.querySelectorAll("#matchRows tr").forEach((tr) => tr.classList.toggle("selected", tr.dataset.match === key));
  updateHash();
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

function setBias(id, v) {
  if (v) S.bias[id] = v;
  else delete S.bias[id];
  store.set("frc-bias", S.bias);
  document.querySelectorAll(`input[data-bias="${CSS.escape(id)}"]`).forEach((el) => {
    el.value = v;
    el.nextElementSibling.textContent = `${v > 0 ? "+" : ""}${v}`;
  });
  renderHero();
  const m = matchOf(S.matchKey);
  if (m) {
    const p = predict(m);
    document.querySelectorAll(".tcard .tnum").forEach((btn) => {
      const pEl = btn.parentElement.querySelector(".tpts");
      if (pEl) pEl.textContent = `${fmt1(p.teamPoints[btn.dataset.team])} pts`;
    });
  }
  clearTimeout(setBias.t);
  setBias.t = setTimeout(() => { renderMatches(); renderTeams(); renderBets(); }, 150);
}

function updateHash() {
  if (!S.data) return;
  const h = new URLSearchParams({ event: S.data.event.key });
  if (S.matchKey) h.set("match", S.matchKey);
  history.replaceState(null, "", `#${h}`);
}

function showBanner(msg) {
  const b = $("banner");
  b.textContent = msg;
  b.hidden = !msg;
}

function wireUi() {
  $("year").addEventListener("change", (e) => loadEvents(Number(e.target.value)));
  const search = $("eventSearch");
  const tryOpen = () => {
    const v = search.value.trim();
    const ev = S.events.find((e) => eventLabel(e) === v || e.key === v.toLowerCase());
    if (ev && ev.key !== S.data?.event.key) openEvent(ev.key);
  };
  search.addEventListener("change", tryOpen);
  search.addEventListener("input", () => { if (S.events.some((e) => eventLabel(e) === search.value)) tryOpen(); });
  search.addEventListener("focus", () => search.select());

  $("matchSelect").addEventListener("change", (e) => selectMatch(e.target.value, false));
  const step = (d) => {
    const ms = S.data?.matches || [];
    const i = ms.findIndex((m) => m.key === S.matchKey);
    if (ms[i + d]) selectMatch(ms[i + d].key, false);
  };
  $("prevMatch").addEventListener("click", () => step(-1));
  $("nextMatch").addEventListener("click", () => step(1));

  $("matchTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    S.tab = b.dataset.tab;
    renderMatches();
  });
  $("teamFilter").addEventListener("input", (e) => {
    S.filter = e.target.value.replace(/\D/g, "");
    renderMatches();
  });

  document.addEventListener("input", (e) => {
    const el = e.target.closest("input[data-bias]");
    if (el) setBias(el.dataset.bias, Number(el.value));
  });

  document.addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) return $("teamDialog").close();
    const team = e.target.closest("[data-team]");
    if (team && !e.target.closest("input")) return openTeam(team.dataset.team);
    const match = e.target.closest("[data-match]");
    if (match) {
      if ($("teamDialog").open) $("teamDialog").close();
      return selectMatch(match.dataset.match);
    }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      S.sort = { key: th.dataset.sort, asc: S.sort.key === th.dataset.sort ? !S.sort.asc : true };
      renderTeams();
    }
  });
  $("teamDialog").addEventListener("click", (e) => { if (e.target === $("teamDialog")) $("teamDialog").close(); });

  $("ouKind").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kind]");
    if (!b) return;
    S.ou = { kind: b.dataset.kind, line: null, auto: true };
    renderOU();
  });
  const nudge = (d) => {
    S.ou.line = (S.ou.line ?? 0) + d * (S.ou.step || 5);
    S.ou.auto = false;
    renderOU();
  };
  $("ouMinus").addEventListener("click", () => nudge(-1));
  $("ouPlus").addEventListener("click", () => nudge(1));
  $("ouLine").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    S.ou.line = v;
    S.ou.auto = false;
    renderOU();
  });
  $("ouLines").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-line]");
    if (!b) return;
    S.ou.line = Number(b.dataset.line);
    S.ou.auto = false;
    renderOU();
  });
  $("betsMore").addEventListener("click", () => {
    S.betsAll = !S.betsAll;
    renderBets();
  });
  $("calibSource").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-src]");
    if (!b) return;
    S.calibSrc = b.dataset.src;
    S.calibPicked = true;
    renderCalibration();
  });

  $("resetBias").addEventListener("click", () => {
    S.bias = {};
    store.set("frc-bias", S.bias);
    renderAll();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.data?.live && Date.now() - S.data.generatedAt > 60_000) refreshEvent();
  });
}

boot();
