// Statbotics API v3: EPA ratings (historical robot strength) and records.
// Every call is best-effort: when Statbotics is down the model still runs
// on TBA match results alone.
import { getJson, mapLimit } from "./fetcher.js";
import { matchLabel } from "./tba.js";

const BASE = "https://api.statbotics.io/v3";
const COMP_ORDER = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };

// Circuit breaker: after a few failures in a row, skip Statbotics for a while
// instead of making every team lookup wait through retries and timeouts.
const breaker = { failures: 0, openUntil: 0 };
export const statboticsDown = () => Date.now() < breaker.openUntil;

async function sb(path, ttlMs) {
  if (statboticsDown()) throw new Error("Statbotics is temporarily unavailable");
  try {
    const data = await getJson(BASE + path, { ttlMs, retries: 1, timeoutMs: 8_000 });
    breaker.failures = 0;
    return data;
  } catch (err) {
    if (!statboticsDown() && ++breaker.failures >= 3) {
      breaker.openUntil = Date.now() + 5 * 60_000;
      breaker.failures = 0;
      console.error("statbotics: failing repeatedly, skipping it for 5 minutes");
    }
    throw err;
  }
}
const safe = (p) => p.catch(() => null);
const isEmpty = (v) => v == null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

const mean = (x) => (typeof x === "number" ? x : x?.mean ?? null);

function epaSummary(epa) {
  if (!epa) return null;
  const b = epa.breakdown || {};
  return {
    total: mean(epa.total_points) ?? b.total_points ?? null,
    auto: b.auto_points ?? null,
    teleop: b.teleop_points ?? null,
    endgame: b.endgame_points ?? null,
    start: epa.stats?.start ?? null,
    max: epa.stats?.max ?? null,
    percentile: epa.ranks?.total?.percentile ?? null,
    worldRank: epa.ranks?.total?.rank ?? null,
    worldCount: epa.ranks?.total?.team_count ?? null,
  };
}

function recordSummary(r) {
  if (!r) return null;
  const rec = r.total || r; // team_event nests qual/elim/total
  const wins = rec.wins ?? 0;
  const losses = rec.losses ?? 0;
  const ties = rec.ties ?? 0;
  const count = rec.count ?? wins + losses + ties;
  return { wins, losses, ties, count, winrate: rec.winrate ?? (count ? (wins + ties / 2) / count : null) };
}

export async function teamYear(team, year) {
  const d = await safe(sb(`/team_year/${team}/${year}`, 3 * 3600_000));
  if (isEmpty(d)) return null;
  return { epa: epaSummary(d.epa), record: recordSummary(d.record) };
}

export async function teamEventsAt(eventKey) {
  const list = await safe(sb(`/team_events?event=${eventKey}&limit=200`, 10 * 60_000));
  const out = {};
  for (const te of Array.isArray(list) ? list : []) {
    out[String(te.team)] = { epa: epaSummary(te.epa), record: recordSummary(te.record) };
  }
  return out;
}

export async function teamYears(teams, year) {
  const rows = await mapLimit(teams, 6, (t) => teamYear(t, year));
  return Object.fromEntries(teams.map((t, i) => [t, rows[i]]));
}

// Used when no TBA key is configured.
export async function sbEvents(year) {
  const list = await sb(`/events?year=${year}&limit=1000`, 30 * 60_000);
  if (isEmpty(list)) throw new Error("Statbotics returned no events");
  return list.map((e) => ({
    key: e.key,
    name: e.name,
    start: e.start_date,
    end: e.end_date,
    location: [e.state, e.country].filter(Boolean).join(", "),
  }));
}

export async function sbEvent(key) {
  const [info, matches, tes] = await Promise.all([
    sb(`/event/${key}`, 30 * 60_000),
    sb(`/matches?event=${key}&limit=1000`, 45_000),
    safe(sb(`/team_events?event=${key}&limit=200`, 10 * 60_000)),
  ]);
  if (isEmpty(info) || !Array.isArray(matches)) throw new Error("Statbotics has no data for this event");
  const teams = (Array.isArray(tes) ? tes : []).map((t) => ({ id: String(t.team), name: t.team_name || `Team ${t.team}`, location: "" }));
  const rankings = {};
  for (const t of Array.isArray(tes) ? tes : []) {
    const q = t.record?.qual;
    if (q) rankings[String(t.team)] = { rank: q.rank ?? null, wins: q.wins ?? 0, losses: q.losses ?? 0, ties: q.ties ?? 0, played: q.count ?? null };
  }
  return {
    event: { key: info.key, name: info.name, start: info.start_date, end: info.end_date, location: [info.state, info.country].filter(Boolean).join(", "), year: info.year },
    teams,
    rankings,
    matches: matches.map((m) => {
      const played = m.status === "Completed" && m.result?.red_score != null;
      const teamsOf = (side) => (m.alliances?.[side]?.team_keys || []).map(String);
      return {
        key: m.key,
        compLevel: m.comp_level,
        elim: Boolean(m.elim),
        label: matchLabel(m.comp_level, m.set_number, m.match_number),
        order: (COMP_ORDER[m.comp_level] ?? 0) * 10000 + (m.set_number ?? 1) * 100 + (m.match_number ?? 0),
        time: m.time ?? m.predicted_time ?? null,
        played,
        red: { teams: teamsOf("red"), score: played ? m.result.red_score : null },
        blue: { teams: teamsOf("blue"), score: played ? m.result.blue_score : null },
      };
    }),
  };
}
