// Jev (TypeSafe AI) decision model. Jev doesn't write text: it answers
// multiple-choice questions with a probability for every option, which maps
// directly onto "who wins" and "which score band".
// Docs: https://jevmodel.net/docs
//
// Works with either a TypeSafe key or a Vercel AI Gateway key (they start
// with "vck_"). The gateway's TypeSafe-compatible endpoint takes the same
// request and returns the same answers, only the URL and model name differ:
// https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe

const jevKey = () => process.env.JEV_API_KEY || process.env.AI_GATEWAY_API_KEY || "";
export const jevEnabled = () => Boolean(jevKey());

export const viaGateway = () => !process.env.JEV_API_KEY || process.env.JEV_API_KEY.startsWith("vck_");

const JEV_URL = () =>
  process.env.JEV_API_URL || (viaGateway() ? "https://ai-gateway.vercel.sh/typesafe/v1/systemone" : "https://jevmodel.net/v1/systemone");
const JEV_MODEL = () => process.env.JEV_MODEL || (viaGateway() ? "typesafe-ai/jev" : "jev-latest");

// Build ~12 score bands around the statistical estimate of the winning score.
export function scoreBands(center, sd) {
  const width = Math.max(5, Math.round((sd * 0.6) / 5) * 5);
  const lo = Math.max(0, Math.floor((center - 5 * width) / width) * width);
  const bands = [];
  for (let i = 0; i < 12; i++) {
    const from = lo + i * width;
    const last = i === 11;
    bands.push({ id: `b${i}`, from, to: last ? null : from + width - 1, mid: last ? from + width : from + width / 2 });
  }
  return bands;
}

function normalizeProbs(raw, options) {
  // Accept { option: p } or [{ option|label|choice, probability|p }].
  const out = {};
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const k = r.option ?? r.label ?? r.choice ?? r.key;
      const p = r.probability ?? r.p ?? r.value;
      if (k != null && Number.isFinite(p)) out[k] = p;
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v)) out[k] = v;
  }
  const total = options.reduce((s, o) => s + (out[o] || 0), 0);
  if (!total) return null;
  return Object.fromEntries(options.map((o) => [o, (out[o] || 0) / total]));
}

export async function askJev({ state, stats, sdAlliance }) {
  const bands = scoreBands(stats.winningScore, sdAlliance);
  const questions = {
    winner: {
      type: "choice",
      instructions:
        "Which alliance will win this FIRST Robotics Competition match? Weigh each team's rating, its results earlier at this event (latest day matters most), its historical win/loss record and robot scoring breakdown, the statistical model's estimate, and the user's personal bias adjustments.",
      criteria: {
        red: "The Red alliance finishes with more points than the Blue alliance.",
        blue: "The Blue alliance finishes with more points than the Red alliance.",
      },
    },
    winning_score: {
      type: "choice",
      instructions: "What will the winning alliance's final score be in this match (including penalty points it receives)?",
      criteria: Object.fromEntries(bands.map((b) => [b.id, b.to == null ? `${b.from} points or more` : `Between ${b.from} and ${b.to} points`])),
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let res;
  try {
    res = await fetch(JEV_URL(), {
      method: "POST",
      headers: { Authorization: `Bearer ${jevKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL(), state, questions }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint = { 401: "API key rejected", 403: "API key not allowed", 422: "request rejected", 429: "rate limited", 529: "Jev is overloaded" }[res.status] || "request failed";
    let detail = "";
    try {
      const err = JSON.parse(text);
      detail = err.message || err.error?.message || (typeof err.error === "string" ? err.error : "");
    } catch {}
    console.error(`jev HTTP ${res.status} via ${viaGateway() ? "AI Gateway" : "TypeSafe"}: ${text.slice(0, 300)}`);
    throw new Error(`Jev ${hint} (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 160)}` : ""}`);
  }
  const body = JSON.parse(text);
  const answers = body.answers || {};

  const win = answers.winner || {};
  const winProbs = normalizeProbs(win.probabilities, ["red", "blue"]);
  if (!winProbs) throw new Error("Jev response had no winner probabilities");

  const sc = answers.winning_score || {};
  const bandProbs = normalizeProbs(sc.probabilities, bands.map((b) => b.id));
  const winningScore = bandProbs ? bands.reduce((s, b) => s + b.mid * bandProbs[b.id], 0) : null;

  return {
    model: body.model || JEV_MODEL(),
    redWinProb: winProbs.red,
    blueWinProb: winProbs.blue,
    confidence: Number.isFinite(win.confidence) ? win.confidence : null,
    winningScore,
    scoreConfidence: Number.isFinite(sc.confidence) ? sc.confidence : null,
    bands: bandProbs ? bands.map((b) => ({ from: b.from, to: b.to, p: bandProbs[b.id] })) : [],
  };
}
