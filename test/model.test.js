import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, backtest, fitRatings, normCdf, playDays, predictMatch } from "../public/lib/model.js";
import { scoreBands } from "../server/jev.js";

const match = (key, red, blue, rs, bs, time) => ({
  key, order: Number(key.slice(1)), time, played: rs != null,
  red: { teams: red, score: rs }, blue: { teams: blue, score: bs },
});

test("normCdf is symmetric and sane", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1) + normCdf(1) - 1) < 1e-6);
});

test("with no matches, ratings equal priors", () => {
  const fit = fitRatings(["1", "2"], { 1: 30, 2: 10 }, []);
  assert.ok(Math.abs(fit.ratings["1"] - 30) < 1e-9);
  assert.ok(Math.abs(fit.ratings["2"] - 10) < 1e-9);
});

test("event results pull ratings toward what teams actually score", () => {
  const teams = ["1", "2", "3", "4", "5", "6"];
  const priors = Object.fromEntries(teams.map((t) => [t, 20]));
  const ms = [];
  // Team 1 is secretly great: every alliance with it scores +30.
  for (let i = 0; i < 12; i++) {
    const red = i % 2 ? ["1", "2", "3"] : ["1", "4", "5"];
    const blue = i % 2 ? ["4", "5", "6"] : ["2", "3", "6"];
    ms.push(match(`m${i + 1}`, red, blue, 90, 60, 1000 + i * 600));
  }
  const fit = fitRatings(teams, priors, ms);
  assert.ok(fit.ratings["1"] > fit.ratings["2"] + 10, `team 1 rating ${fit.ratings["1"]}`);
  const p = predictMatch(match("m99", ["1", "2", "3"], ["4", "5", "6"]), fit);
  assert.ok(p.redWinProb > 0.8);
  assert.equal(p.winner, "red");
  // the winner usually had a good day, so the winning score sits a bit above the favorite's prediction
  assert.ok(p.winningScore >= p.redScore && p.winningScore < p.redScore + p.sd);
});

test("bias moves win probability in the expected direction", () => {
  const fit = fitRatings(["1", "2", "3", "4", "5", "6"], { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 20 }, []);
  const m = match("m1", ["1", "2", "3"], ["4", "5", "6"]);
  assert.ok(Math.abs(predictMatch(m, fit).redWinProb - 0.5) < 1e-9);
  assert.ok(predictMatch(m, fit, { bias: { 1: 100 } }).redWinProb > 0.55);
  assert.ok(predictMatch(m, fit, { bias: { 4: 100 } }).redWinProb < 0.45);
});

test("latest day of play is weighted most", () => {
  const day1 = 0;
  const day2 = 30 * 3600;
  const ms = [match("m1", ["1"], ["2"], 50, 10, day1), match("m2", ["1"], ["2"], 10, 50, day2)];
  const days = playDays(ms);
  assert.equal(days.get("m2"), 0);
  assert.equal(days.get("m1"), 1);
  const fit = fitRatings(["1", "2"], { 1: 30, 2: 30 }, ms);
  assert.ok(fit.ratings["2"] > fit.ratings["1"], "team 2 won today, so it should rate higher");
});

test("backtest only uses earlier matches", () => {
  const ms = [match("m1", ["1"], ["2"], 50, 10, 0), match("m2", ["1"], ["2"], 50, 10, 600)];
  const bt = backtest(["1", "2"], { 1: 30, 2: 30 }, ms, {});
  assert.ok(Math.abs(bt.results.m1.redWinProb - 0.5) < 1e-9, "first match has no prior evidence");
  assert.ok(bt.results.m2.redWinProb > 0.5);
  assert.equal(bt.summary.matches, 2);
});

test("Jev score bands are contiguous and cover the estimate", () => {
  const bands = scoreBands(140, 25);
  assert.equal(bands.length, 12);
  for (let i = 1; i < bands.length; i++) assert.equal(bands[i].from, bands[i - 1].to + 1);
  assert.ok(bands[0].from <= 140 && bands[11].from > 140);
});

test("score stats count misses within ±25 and ±5", async () => {
  const { ScoreStats } = await import("../public/lib/model.js");
  const s = new ScoreStats();
  s.add({ redScore: 100, blueScore: 50 }, { red: { score: 104 }, blue: { score: 80 } });
  const r = s.summary();
  assert.equal(r.scoreError, (4 + 30) / 2);
  assert.equal(r.within25, 0.5);
  assert.equal(r.within5, 0.5);
  assert.equal(r.winScoreError, 4);
});

test("playoff scale only applies to playoff matches", () => {
  const fit = fitRatings(["1", "2"], { 1: 30, 2: 30 }, []);
  const opts = { ...DEFAULTS, elimScale: 1.1 };
  const qual = predictMatch({ ...match("q", ["1"], ["2"]), elim: false }, fit, { opts });
  const elim = predictMatch({ ...match("e", ["1"], ["2"]), elim: true }, fit, { opts });
  assert.ok(Math.abs(qual.redScore - 30) < 1e-9);
  assert.ok(Math.abs(elim.redScore - 33) < 1e-9);
});

test("history prior weights the latest earlier event most and ignores later ones", async () => {
  const { historyPrior } = await import("../server/history.js");
  const h = { byTeam: { 254: [{ end: "2026-03-01", opr: 20 }, { end: "2026-03-15", opr: 40 }, { end: "2026-04-20", opr: 99 }] } };
  // weights 0.5 and 1 -> (10 + 40) / 1.5
  assert.ok(Math.abs(historyPrior(h, "254", "2026-04-01") - 50 / 1.5) < 1e-9);
  assert.equal(historyPrior(h, "254", "2026-02-01"), null);
  assert.ok(Math.abs(historyPrior(h, "254", "2026-04-01", 1.1) - (50 / 1.5) * 1.1) < 1e-9);
});

test("over/under probabilities are consistent", async () => {
  const { overProb, winQuantile } = await import("../public/lib/model.js");
  const pred = { redScore: 100, blueScore: 80, sd: 20 };
  assert.ok(Math.abs(overProb(pred, "red", 100) - 0.5) < 1e-6);
  assert.ok(Math.abs(overProb(pred, "total", 180) - 0.5) < 1e-6);
  const median = winQuantile(100, 80, 20, 0.5);
  assert.ok(Math.abs(overProb(pred, "winning", median) - 0.5) < 1e-4);
  assert.ok(median > 100, "winning score median is above the higher prediction");
  assert.ok(overProb(pred, "winning", 150) < overProb(pred, "winning", 120));
});

test("calibration bins group by favorite probability", async () => {
  const { calibrationBins } = await import("../public/lib/model.js");
  const bins = calibrationBins([{ p: 0.85, won: true }, { p: 0.15, won: true }, { p: 0.55, won: false }]);
  const b80 = bins.find((b) => b.lo === 0.8);
  assert.equal(b80.n, 2);
  assert.equal(b80.actual, 0.5); // red favored and won; blue favored (p=0.15) but red won
  assert.equal(bins.find((b) => b.lo === 0.5).actual, 0);
});
