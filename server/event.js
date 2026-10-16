// Assemble everything the UI needs for one event: schedule + results,
// historical team data, fitted ratings, and a replayed accuracy check.
import { tbaEnabled, tbaEvent } from "./tba.js";
import { sbEvent, teamEventsAt, teamYears } from "./statbotics.js";
import { DEMO_KEY, demoEvent } from "./demo.js";
import { DEFAULTS, backtest, fitRatings, playDays, predictMatch } from "../public/lib/model.js";
import { historyEvents, historyPrior, seasonHistory } from "./history.js";
import { tunedOptions } from "./tuner.js";
import { recordEvent } from "./tracker.js";

const cache = new Map(); // key -> { data, expires }
const inflight = new Map();
const TTL_MS = 30_000;

export function loadEvent(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  if (inflight.has(key)) return inflight.get(key);
  const task = build(key)
    .then((data) => {
      cache.set(key, { data, expires: Date.now() + TTL_MS });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function build(key) {
  let base;
  let source;
  if (key === DEMO_KEY) {
    base = demoEvent();
    source = "demo";
  } else if (tbaEnabled()) {
    base = await tbaEvent(key);
    source = "tba";
  } else {
    base = await sbEvent(key);
    source = "statbotics";
  }

  const matches = base.matches.sort((a, b) => a.order - b.order);
  const ids = new Set(base.teams.map((t) => t.id));
  for (const m of matches) for (const t of [...m.red.teams, ...m.blue.teams]) ids.add(t);
  const teamIds = [...ids].sort((a, b) => Number(a) - Number(b));
  const year = base.event.year || Number(String(key).slice(0, 4));

  let teamEvents, seasons, lastSeasons;
  if (base.statbotics) {
    ({ teamEvents, teamYears: seasons, lastYears: lastSeasons } = base.statbotics);
  } else {
    [teamEvents, seasons, lastSeasons] = await Promise.all([teamEventsAt(key), teamYears(teamIds, year), teamYears(teamIds, year - 1)]);
  }

  const opts = source === "demo" ? { ...DEFAULTS } : tunedOptions();
  // Wait briefly for the season history on a cold start; after that it's instant.
  const seasonIdx = source === "demo" ? null : seasonHistory(year);
  if (seasonIdx?.building && !seasonIdx.events) await Promise.race([seasonIdx.building, new Promise((r) => setTimeout(r, 10_000))]);
  const start = base.event.start || "9999";

  const priors = {};
  const priorSource = {};
  const form = {};
  for (const t of teamIds) {
    const te = teamEvents[t]?.epa;
    const ty = seasons[t];
    // EPA entering this event avoids counting this event's matches twice.
    const epa = te?.start ?? te?.total ?? ty?.epa?.total ?? null;
    const past = epa == null ? historyPrior(seasonIdx, t, start, opts.priorScale) : null;
    priors[t] = epa ?? past;
    priorSource[t] = epa != null ? "epa" : past != null ? "history" : null;
    form[t] = ty?.record?.winrate ?? lastSeasons[t]?.record?.winrate ?? null;
  }

  const fit = fitRatings(teamIds, priors, matches, opts);
  const bt = backtest(teamIds, priors, matches, form, opts);
  if (source !== "demo" && fit.hasData) {
    const preds = {};
    for (const m of matches) if (!m.played) preds[m.key] = predictMatch(m, fit, { form, opts });
    recordEvent({ key, name: base.event.name }, matches, preds);
  }
  const played = matches.filter((m) => m.played);
  const days = playDays(played);
  const lastPlayed = played.reduce((mx, m) => Math.max(mx, m.time || 0), 0);
  const live = lastPlayed > 0 && Date.now() / 1000 - lastPlayed < 18 * 3600;

  const names = Object.fromEntries(base.teams.map((t) => [t.id, t]));
  const teams = teamIds.map((id) => {
    const history = [];
    for (const m of played) {
      const side = m.red.teams.includes(id) ? "red" : m.blue.teams.includes(id) ? "blue" : null;
      if (!side) continue;
      const other = side === "red" ? "blue" : "red";
      const us = m[side].score;
      const them = m[other].score;
      history.push({ key: m.key, label: m.label, alliance: side, score: us, opp: them, result: us > them ? "W" : us < them ? "L" : "T", latestDay: days.get(m.key) === 0 });
    }
    const rank = base.rankings[id] || null;
    const season = seasons[id] || teamEvents[id] || null;
    return {
      id,
      name: names[id]?.name || `Team ${id}`,
      location: names[id]?.location || "",
      rank: rank?.rank ?? null,
      record: rank ? { wins: rank.wins, losses: rank.losses, ties: rank.ties } : tally(history),
      prior: fit.priors[id],
      priorKnown: Number.isFinite(priors[id]),
      priorSource: priorSource[id],
      pastEvents: historyEvents(seasonIdx, id, start).map((x) => ({ event: x.event, opr: x.opr })),
      rating: fit.ratings[id],
      avgScore: history.length ? history.reduce((s, h) => s + h.score, 0) / history.length : null,
      season: season ? { epa: season.epa, record: season.record } : null,
      lastSeason: lastSeasons[id] ? { epa: lastSeasons[id].epa, record: lastSeasons[id].record } : null,
      history,
    };
  });

  return {
    event: { ...base.event, key },
    source,
    hasEpa: Object.values(priorSource).includes("epa"),
    priorCounts: {
      epa: Object.values(priorSource).filter((v) => v === "epa").length,
      history: Object.values(priorSource).filter((v) => v === "history").length,
      none: Object.values(priorSource).filter((v) => !v).length,
    },
    opts,
    generatedAt: Date.now(),
    live,
    fit,
    form,
    teams,
    matches: matches.map((m) => ({ ...m, latestDay: m.played && days.get(m.key) === 0, pre: bt.results[m.key] || null })),
    accuracy: bt.summary,
  };
}

function tally(history) {
  const r = { wins: 0, losses: 0, ties: 0 };
  for (const h of history) r[h.result === "W" ? "wins" : h.result === "L" ? "losses" : "ties"]++;
  return r;
}

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const recStr = (r) => (r ? `${r.wins}-${r.losses}-${r.ties}` : null);

// Compact description of a match for the Jev decision model.
export function jevState(data, match, bias) {
  const stats = predictMatch(match, data.fit, { bias, form: data.form, opts: data.opts });
  const byId = Object.fromEntries(data.teams.map((t) => [t.id, t]));
  const teamState = (id) => {
    const t = byId[id] || { id };
    const b = bias[id] || 0;
    return {
      team: Number(id),
      name: t.name,
      event_rank: t.rank,
      event_record: recStr(t.record),
      points_contributed_now: round(data.fit.ratings[id]),
      points_contributed_entering_event: round(data.fit.priors[id]),
      season_epa: round(t.season?.epa?.total),
      season_epa_breakdown: t.season?.epa ? { auto: round(t.season.epa.auto), teleop: round(t.season.epa.teleop), endgame: round(t.season.epa.endgame) } : null,
      season_epa_percentile: round(t.season?.epa?.percentile, 2),
      season_record: recStr(t.season?.record),
      last_season_epa: round(t.lastSeason?.epa?.total),
      last_season_record: recStr(t.lastSeason?.record),
      earlier_events_this_season: (t.pastEvents || []).slice(-4).map((e) => ({ event: e.event, opr: round(e.opr) })),
      recent_matches: (t.history || []).slice(-5).map((h) => ({ match: h.label, alliance_score: h.score, opponent_score: h.opp, result: h.result, latest_day: h.latestDay })),
      user_bias: b === 0 ? "none" : `${b > 0 ? "+" : ""}${b} on a -100..100 scale (user expects this team to do ${b > 0 ? "better" : "worse"} than its stats)`,
    };
  };
  const state = {
    event: data.event.name,
    match: match.label,
    playoff: match.elim,
    typical_alliance_score_at_event: round(data.fit.avgAlliance),
    statistical_model: {
      red_win_probability: round(stats.redWinProb, 3),
      predicted_red_score: round(stats.redScore),
      predicted_blue_score: round(stats.blueScore),
    },
    red_alliance: match.red.teams.map(teamState),
    blue_alliance: match.blue.teams.map(teamState),
  };
  return { state, stats };
}
