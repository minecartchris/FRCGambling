// Auto-tuner: replays recently finished events with different model settings
// and keeps the ones with the smallest average score miss. Runs in the
// background at startup and once a day; results are saved in DATA_DIR so the
// model keeps what it learned across restarts.
import { DEFAULTS, ScoreStats, TUNABLE, calibrationBins, fitRatings, predictMatch } from "../public/lib/model.js";
import { convertMatches, tbaEnabled } from "./tba.js";
import { finishedEventData, historyPrior, seasonEvents, seasonHistoryReady } from "./history.js";
import { readJson, writeJson } from "./store.js";

const GRID = {
  ridge: [0.5, 1, 2, 3, 5],
  dayDecay: [0.4, 0.6, 0.75, 0.9, 1],
  robust: [0, 2],
  elimScale: [0.9, 0.95, 1, 1.05, 1.1],
  priorScale: [0.9, 1, 1.1, 1.2],
};
const SPREADS = [1, 1.2, 1.35, 1.5, 1.65, 1.8, 2];
const MAX_EVENTS = 60;
const EVERY_MS = 24 * 3600_000;
const VERSION = 2; // bump when the model changes so saved settings get re-tuned

let tuning = null; // { params, before, after, events, matches, tunedAt, year }
let running = null;

export const getTuning = () => tuning;
export const tunedOptions = () => ({ ...DEFAULTS, ...(tuning?.params || {}) });

const pause = () => new Promise((r) => setImmediate(r));
const pick = (o) => Object.fromEntries(TUNABLE.map((k) => [k, o[k]]));

async function dataset(year) {
  const history = await seasonHistoryReady(year);
  const today = new Date().toISOString().slice(0, 10);
  const events = (await seasonEvents(year)).filter((e) => e.event_type !== 100 && e.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date));
  const out = [];
  for (const e of events) {
    if (out.length >= MAX_EVENTS) break;
    const matches = convertMatches(await finishedEventData(e, "matches/simple"))
      .filter((m) => m.played)
      .sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.order - b.order);
    if (matches.length < 40) continue;
    const teams = [...new Set(matches.flatMap((m) => [...m.red.teams, ...m.blue.teams]))];
    const basePriors = Object.fromEntries(teams.map((t) => [t, historyPrior(history, t, e.start_date, 1)]));
    out.push({ key: e.key, teams, matches, basePriors });
  }
  return out;
}

async function evaluate(data, opts) {
  const stats = new ScoreStats();
  const calib = [];
  let wins = 0, correct = 0, brier = 0;
  for (const d of data) {
    const priors = Object.fromEntries(Object.entries(d.basePriors).map(([t, v]) => [t, v == null ? null : v * opts.priorScale]));
    for (let i = 0; i < d.matches.length; i++) {
      const m = d.matches[i];
      const fit = fitRatings(d.teams, priors, d.matches.slice(0, i), opts);
      if (!fit.hasData) continue;
      const p = predictMatch(m, fit, { opts });
      stats.add(p, m);
      if (m.red.score !== m.blue.score) {
        const redWon = m.red.score > m.blue.score;
        wins++;
        if ((p.redWinProb >= 0.5) === redWon) correct++;
        brier += (p.redWinProb - (redWon ? 1 : 0)) ** 2;
        calib.push({ p: p.redWinProb, won: redWon });
      }
    }
    await pause(); // keep the server responsive while tuning
  }
  return { ...stats.summary(), accuracy: wins ? correct / wins : null, brier: wins ? brier / wins : null, calibration: calibrationBins(calib) };
}

export async function tune(year) {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const data = await dataset(year);
    if (data.length < 5) {
      console.log(`tuner: only ${data.length} finished events for ${year}, keeping current settings`);
      return tuning;
    }
    const before = await evaluate(data, { ...DEFAULTS });
    let best = { ...DEFAULTS, ...(tuning?.year === year && tuning.version === VERSION ? tuning.params : {}) };
    let bestR = await evaluate(data, best);
    for (let pass = 0; pass < 2; pass++) {
      let improved = false;
      for (const [key, values] of Object.entries(GRID)) {
        for (const v of values) {
          if (best[key] === v) continue;
          const cand = { ...best, [key]: v };
          const r = await evaluate(data, cand);
          if (r.scoreError < bestR.scoreError - 1e-6) {
            best = cand;
            bestR = r;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    // Spread doesn't change the average miss; tune it so the 80% range holds ~80%.
    for (const spreadScale of SPREADS) {
      if (best.spreadScale === spreadScale) continue;
      const cand = { ...best, spreadScale };
      const r = await evaluate(data, cand);
      if (Math.abs(r.rangeHit - 0.8) < Math.abs(bestR.rangeHit - 0.8)) {
        best = cand;
        bestR = r;
      }
    }
    tuning = {
      version: VERSION,
      year,
      params: pick(best),
      before,
      after: bestR,
      events: data.length,
      matches: data.reduce((s, d) => s + d.matches.length, 0),
      tunedAt: Date.now(),
      seconds: Math.round((Date.now() - started) / 1000),
    };
    await writeJson("tuning.json", tuning);
    console.log(`tuner: ${tuning.events} events, avg miss ${before.scoreError.toFixed(1)} -> ${bestR.scoreError.toFixed(1)} pts in ${tuning.seconds}s`, JSON.stringify(tuning.params));
    return tuning;
  })()
    .catch((err) => console.error("tuner:", err.message))
    .finally(() => (running = null));
  return running;
}

export async function startTuner(seasonFn) {
  tuning = await readJson("tuning.json");
  if (tuning) console.log(`tuner: loaded settings from ${new Date(tuning.tunedAt).toISOString()}`, JSON.stringify(tuning.params));
  if (!tbaEnabled()) return;
  const runIfStale = async () => {
    const year = await seasonFn();
    if (!tuning || tuning.version !== VERSION || tuning.year !== year || Date.now() - tuning.tunedAt > EVERY_MS) await tune(year);
  };
  setTimeout(runIfStale, 5_000).unref();
  setInterval(runIfStale, 3600_000).unref();
}
