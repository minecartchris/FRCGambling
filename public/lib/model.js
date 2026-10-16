// Prediction model shared by the server (Node) and the browser.
//
// 1. Each team starts from a prior rating: its Statbotics EPA entering the
//    event (points the team adds to its alliance's score).
// 2. Completed matches at the event update those ratings with a ridge
//    regression pulled toward the prior: few matches -> mostly prior, many
//    matches -> mostly what the team actually scored. The latest day of play
//    is weighted most, so today's matches count the most.
// 3. A small "form" term uses historical win rate.
// 4. Personal bias sliders shift a team's rating up or down.
// 5. Win probability = P(margin > 0) with margin ~ Normal(mu, sigma), where
//    sigma comes from how far real scores landed from the fit.

export const DEFAULTS = {
  ridge: 3,               // prior strength, in "matches worth" of evidence
  dayDecay: 0.75,         // weight multiplier per earlier day of play
  dayGapHours: 10,        // gap between matches that starts a new day of play
  biasScale: 0.35,        // slider at +100 adds 35% of an average team's points
  formWeight: 0.04,       // max +/-4% of an alliance score from win-rate edge
  sigmaPriorMatches: 10,  // how quickly observed scatter replaces the default
  defaultSdFrac: 0.22,    // default alliance-score SD as a fraction of the mean
  residualInflation: 1.2, // in-sample residuals underestimate future error
  robust: 0,              // Huber threshold in default-SD units; 0 = plain least squares (auto-tuned)
  elimScale: 1,           // playoff scores relative to quals (auto-tuned)
  priorScale: 1,          // ratings from earlier events x this (teams improve; auto-tuned)
};

// Settings the auto-tuner may change. Everything else stays at DEFAULTS.
export const TUNABLE = ["ridge", "dayDecay", "robust", "elimScale", "priorScale"];

export function normCdf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const isPlayed = (m) => m.played && Number.isFinite(m.red.score) && Number.isFinite(m.blue.score);

// Assign each match a day-of-play index (0 = latest day) by clustering times.
export function playDays(matches, opts = DEFAULTS) {
  const timed = matches.filter((m) => Number.isFinite(m.time)).sort((a, b) => a.time - b.time);
  const dayOf = new Map();
  let day = 0;
  let prev = null;
  for (const m of timed) {
    if (prev !== null && m.time - prev > opts.dayGapHours * 3600) day++;
    dayOf.set(m.key, day);
    prev = m.time;
  }
  const last = day;
  const out = new Map();
  for (const m of matches) out.set(m.key, dayOf.has(m.key) ? last - dayOf.get(m.key) : 0);
  return out;
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-9);
  }
  return x;
}

// teams: ["254", ...]; priors: {"254": 31.2 | null}; matches: all event matches.
export function fitRatings(teams, priors, matches, opts = DEFAULTS) {
  const played = matches.filter(isPlayed);
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;

  const knownPriors = teams.map((t) => priors[t]).filter(Number.isFinite);
  const observedAvg = played.length
    ? played.reduce((s, m) => s + m.red.score + m.blue.score, 0) / (2 * played.length)
    : null;
  const priorAvg = knownPriors.length ? (3 * knownPriors.reduce((s, v) => s + v, 0)) / knownPriors.length : null;
  const avgAlliance = observedAvg ?? priorAvg ?? 0;
  const fallbackPrior = (priorAvg ?? avgAlliance) / 3;
  const prior = teams.map((t) => (Number.isFinite(priors[t]) ? priors[t] : fallbackPrior));

  const days = playDays(played, opts);
  const rows = [];
  for (const m of played) {
    const w = Math.pow(opts.dayDecay, days.get(m.key) || 0);
    for (const side of ["red", "blue"]) {
      const ids = m[side].teams.map((t) => idx.get(t)).filter((i) => i !== undefined);
      if (ids.length) rows.push({ ids, score: m[side].score, w });
    }
  }
  const solveWeighted = (rowWeight) => {
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    rows.forEach((r, k) => {
      const w = r.w * rowWeight(k);
      for (const i of r.ids) {
        b[i] += w * r.score;
        for (const j of r.ids) A[i][j] += w;
      }
    });
    for (let i = 0; i < n; i++) {
      A[i][i] += opts.ridge;
      b[i] += opts.ridge * prior[i];
    }
    return n ? solve(A, b) : [];
  };
  let x = solveWeighted(() => 1);
  // Robust (Huber) refit: a match far off the fit (robot died, huge penalty)
  // gets less weight, so one fluke doesn't drag a team's rating around.
  if (opts.robust > 0 && rows.length > 6) {
    const huber = opts.robust * Math.max(1, opts.defaultSdFrac * avgAlliance);
    for (let iter = 0; iter < 2; iter++) {
      const res = rows.map((r) => Math.abs(r.score - r.ids.reduce((s, i) => s + x[i], 0)));
      x = solveWeighted((k) => (res[k] <= huber ? 1 : huber / res[k]));
    }
  }

  let sse = 0;
  for (const r of rows) {
    const pred = r.ids.reduce((s, i) => s + x[i], 0);
    sse += (r.score - pred) ** 2;
  }
  const defaultSd = Math.max(1, opts.defaultSdFrac * avgAlliance);
  const k = rows.length;
  const fitSd = k ? Math.sqrt(sse / k) * opts.residualInflation : defaultSd;
  const sdAlliance = Math.sqrt((k * fitSd ** 2 + opts.sigmaPriorMatches * defaultSd ** 2) / (k + opts.sigmaPriorMatches));

  const ratings = {};
  const priorUsed = {};
  teams.forEach((t, i) => {
    ratings[t] = x[i];
    priorUsed[t] = prior[i];
  });
  const latestDay = played.filter((m) => days.get(m.key) === 0).length;
  return {
    ratings,
    priors: priorUsed,
    avgAlliance,
    sdAlliance,
    sigmaMargin: Math.SQRT2 * sdAlliance,
    playedCount: played.length,
    latestDayCount: latestDay,
    hasData: knownPriors.length > 0 || played.length > 0,
  };
}

// bias: {"254": -100..100}; form: {"254": 0..1 win rate}
export function predictMatch(match, fit, { bias = {}, form = {}, opts = DEFAULTS } = {}) {
  const teamAvg = fit.avgAlliance / 3;
  // A robot can't score negative points, even if the regression says so.
  const rate = (t) => Math.max(0, (fit.ratings[t] ?? teamAvg) + ((bias[t] || 0) / 100) * opts.biasScale * teamAvg);
  const avgForm = (ts) => (ts.length ? ts.reduce((s, t) => s + (Number.isFinite(form[t]) ? form[t] : 0.5), 0) / ts.length : 0.5);

  const formAdj = opts.formWeight * fit.avgAlliance * (avgForm(match.red.teams) - avgForm(match.blue.teams));
  const scale = match.elim ? opts.elimScale ?? 1 : 1;
  const redScore = (match.red.teams.reduce((s, t) => s + rate(t), 0) + formAdj / 2) * scale;
  const blueScore = (match.blue.teams.reduce((s, t) => s + rate(t), 0) - formAdj / 2) * scale;
  const margin = redScore - blueScore;
  const redWinProb = fit.sigmaMargin > 0 ? normCdf(margin / fit.sigmaMargin) : 0.5;
  const winner = redWinProb >= 0.5 ? "red" : "blue";
  const winningScore = Math.max(redScore, blueScore);
  return {
    redScore,
    blueScore,
    margin,
    redWinProb,
    blueWinProb: 1 - redWinProb,
    winner,
    winningScore,
    // ~80% range for the winning alliance's score
    winningScoreRange: [Math.max(0, winningScore - 1.28 * fit.sdAlliance), winningScore + 1.28 * fit.sdAlliance],
    teamPoints: Object.fromEntries([...match.red.teams, ...match.blue.teams].map((t) => [t, rate(t) * scale])),
    formAdj,
  };
}

// Replay the event: predict every completed match using only earlier matches.
export function backtest(teams, priors, matches, form, opts = DEFAULTS) {
  const played = matches.filter(isPlayed).sort((a, b) => (a.time ?? a.order) - (b.time ?? b.order) || a.order - b.order);
  const results = {};
  let n = 0, correct = 0, brier = 0;
  const score = new ScoreStats();
  const thirds = [new ScoreStats(), new ScoreStats(), new ScoreStats()];
  for (let i = 0; i < played.length; i++) {
    const m = played[i];
    const fit = fitRatings(teams, priors, played.slice(0, i), opts);
    if (!fit.hasData) {
      // Nothing known yet (no history, first match): no real prediction to grade.
      results[m.key] = { redWinProb: 0.5, redScore: null, blueScore: null, correct: null };
      continue;
    }
    const p = predictMatch(m, fit, { form, opts });
    const actual = m.red.score > m.blue.score ? 1 : m.red.score < m.blue.score ? 0 : 0.5;
    const ok = actual === 0.5 ? null : (p.redWinProb >= 0.5) === (actual === 1);
    results[m.key] = { redWinProb: p.redWinProb, redScore: p.redScore, blueScore: p.blueScore, correct: ok };
    if (ok !== null) {
      n++;
      if (ok) correct++;
      brier += (p.redWinProb - actual) ** 2;
    }
    score.add(p, m);
    thirds[Math.min(2, Math.floor((3 * i) / played.length))].add(p, m);
  }
  return {
    results,
    summary: {
      matches: n,
      accuracy: n ? correct / n : null,
      brier: n ? brier / n : null,
      ...score.summary(),
      byThird: thirds.map((t) => t.summary().scoreError),
    },
  };
}

// Score accuracy: how far predicted alliance scores land from real ones.
export class ScoreStats {
  constructor() {
    this.n = 0;      // alliance scores graded (2 per match)
    this.abs = 0;
    this.in25 = 0;
    this.in5 = 0;
    this.win = 0;    // matches graded for winning score
    this.winAbs = 0;
  }
  add(pred, match) {
    for (const [p, a] of [[pred.redScore, match.red.score], [pred.blueScore, match.blue.score]]) {
      const e = Math.abs(p - a);
      this.n++;
      this.abs += e;
      if (e <= 25) this.in25++;
      if (e <= 5) this.in5++;
    }
    this.win++;
    this.winAbs += Math.abs(Math.max(pred.redScore, pred.blueScore) - Math.max(match.red.score, match.blue.score));
  }
  summary() {
    return {
      scoreError: this.n ? this.abs / this.n : null,
      within25: this.n ? this.in25 / this.n : null,
      within5: this.n ? this.in5 / this.n : null,
      winScoreError: this.win ? this.winAbs / this.win : null,
      scored: this.win,
    };
  }
}
