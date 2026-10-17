// Live track record: the last prediction made before each match was played,
// graded against the real score once it's posted. Unlike the event replay,
// these are predictions people actually saw. Saved in DATA_DIR.
import { ScoreStats, calibrationBins } from "../public/lib/model.js";
import { readJson, writeJson } from "./store.js";

const FILE = "predictions.json";
const MAX_RECORDS = 20_000;
let log = null; // { [matchKey]: record }
let dirty = false;

export async function startTracker() {
  log = (await readJson(FILE)) || {};
  setInterval(flush, 15_000).unref();
}

async function flush() {
  if (!dirty || !log) return;
  dirty = false;
  const keys = Object.keys(log);
  if (keys.length > MAX_RECORDS) {
    keys.sort((a, b) => (log[a].time ?? 0) - (log[b].time ?? 0)).slice(0, keys.length - MAX_RECORDS).forEach((k) => delete log[k]);
  }
  await writeJson(FILE, log).catch((err) => console.error("tracker:", err.message));
}
export const flushTracker = flush;

const r1 = (v) => Math.round(v * 10) / 10;

// Called each time an event is (re)built. preds: { matchKey: stats prediction }
export function recordEvent(event, matches, preds) {
  if (!log) return;
  for (const m of matches) {
    const rec = log[m.key];
    if (!m.played) {
      const p = preds[m.key];
      if (!p) continue;
      log[m.key] = {
        ...rec,
        event: event.key,
        eventName: event.name,
        label: m.label,
        time: m.time,
        at: Date.now(),
        stats: { red: r1(p.redScore), blue: r1(p.blueScore), win: r1(p.winningScore), sd: r1(p.sd), redWinProb: Math.round(p.redWinProb * 1000) / 1000 },
      };
      dirty = true;
    } else if (rec && !rec.actual) {
      rec.actual = { red: m.red.score, blue: m.blue.score };
      dirty = true;
    }
  }
}

// Jev answers made with no personal bias are graded too.
export function recordJev(matchKey, jev) {
  const rec = log?.[matchKey];
  if (!rec || rec.actual) return;
  rec.jev = { redWinProb: Math.round(jev.redWinProb * 1000) / 1000, winningScore: jev.winningScore == null ? null : r1(jev.winningScore) };
  dirty = true;
}

function grade(records) {
  const stats = new ScoreStats();
  let wins = 0, statsRight = 0, jevN = 0, jevRight = 0, jevWinAbs = 0, jevWinN = 0;
  const statsCal = [], jevCal = [];
  for (const r of records) {
    const { red, blue } = r.actual;
    stats.add({ redScore: r.stats.red, blueScore: r.stats.blue, winningScore: r.stats.win, sd: r.stats.sd }, { red: { score: red }, blue: { score: blue } });
    if (red === blue) continue;
    wins++;
    if ((r.stats.redWinProb >= 0.5) === (red > blue)) statsRight++;
    statsCal.push({ p: r.stats.redWinProb, won: red > blue });
    if (r.jev) {
      jevN++;
      jevCal.push({ p: r.jev.redWinProb, won: red > blue });
      if ((r.jev.redWinProb >= 0.5) === (red > blue)) jevRight++;
      if (r.jev.winningScore != null) {
        jevWinN++;
        jevWinAbs += Math.abs(r.jev.winningScore - Math.max(red, blue));
      }
    }
  }
  return {
    ...stats.summary(),
    accuracy: wins ? statsRight / wins : null,
    calibration: calibrationBins(statsCal),
    jev: jevN ? { matches: jevN, accuracy: jevRight / jevN, winScoreError: jevWinN ? jevWinAbs / jevWinN : null, calibration: calibrationBins(jevCal) } : null,
  };
}

export function trackRecord() {
  const graded = Object.values(log || {}).filter((r) => r.actual && r.stats);
  const byEvent = {};
  for (const r of graded) (byEvent[r.event] ||= { name: r.eventName, records: [] }).records.push(r);
  // Is the model getting better? Compare the older half with the newer half.
  const sorted = graded.slice().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  const half = Math.floor(sorted.length / 2);
  return {
    overall: grade(graded),
    trend: sorted.length >= 20 ? { older: grade(sorted.slice(0, half)).scoreError, newer: grade(sorted.slice(half)).scoreError } : null,
    events: Object.entries(byEvent)
      .map(([key, v]) => ({ key, name: v.name, ...grade(v.records) }))
      .sort((a, b) => b.scored - a.scored)
      .slice(0, 20),
    pending: Object.values(log || {}).filter((r) => !r.actual).length,
  };
}
