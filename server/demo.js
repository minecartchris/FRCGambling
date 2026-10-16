// Synthetic event used only when neither TBA nor Statbotics can supply data
// (no TBA key and Statbotics down). Clearly labelled as demo data in the UI.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const DEMO_KEY = "demo";

export function demoEvent() {
  const r = rng(1690);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  const names = ["Gearheads", "Voltage", "Robo Raiders", "Iron Owls", "Circuit Breakers", "Torque", "Byte Force", "Overclocked", "Cyber Knights", "Mech Tigers", "Photon", "Steel Hawks", "Quantum", "Spark", "Titanium", "Nuts & Bolts", "Flux", "Ampere", "Kilowatt", "Servo Squad", "PID Pirates", "Lazer Bears", "Encoders", "Swerve Lords"];
  const teams = names.map((name, i) => ({ id: String(100 + i * 37 + Math.floor(r() * 30)), name, location: "Demo City" }));
  const truth = Object.fromEntries(teams.map((t) => [t.id, Math.max(4, 22 + 9 * gauss())]));

  const start = Math.floor(Date.now() / 1000) - 26 * 3600; // day 1 yesterday, day 2 today
  const matches = [];
  const total = 48;
  for (let n = 1; n <= total; n++) {
    const pool = [...teams].sort(() => r() - 0.5).slice(0, 6).map((t) => t.id);
    const red = pool.slice(0, 3);
    const blue = pool.slice(3);
    const dayTwo = n > 24;
    const time = start + (dayTwo ? 24 * 3600 : 0) + ((n - 1) % 24) * 9 * 60;
    const played = n <= 38;
    const score = (ts) => Math.max(0, Math.round(ts.reduce((s, t) => s + truth[t], 0) + 14 * gauss()));
    matches.push({
      key: `demo_qm${n}`,
      compLevel: "qm",
      elim: false,
      label: `Qual ${n}`,
      order: n,
      time,
      played,
      red: { teams: red, score: played ? score(red) : null },
      blue: { teams: blue, score: played ? score(blue) : null },
    });
  }

  const rankings = {};
  for (const m of matches.filter((x) => x.played)) {
    for (const side of ["red", "blue"]) {
      const other = side === "red" ? "blue" : "red";
      for (const t of m[side].teams) {
        const rec = (rankings[t] ||= { wins: 0, losses: 0, ties: 0, played: 0 });
        rec.played++;
        if (m[side].score > m[other].score) rec.wins++;
        else if (m[side].score < m[other].score) rec.losses++;
        else rec.ties++;
      }
    }
  }
  Object.entries(rankings)
    .sort((a, b) => b[1].wins - a[1].wins || a[1].losses - b[1].losses)
    .forEach(([, rec], i) => (rec.rank = i + 1));

  const sb = {};
  for (const t of teams) {
    const epa = truth[t.id] + 5 * gauss();
    const wins = Math.round(4 + r() * 8);
    const losses = Math.round(2 + r() * 8);
    sb[t.id] = {
      epa: { total: epa, auto: epa * 0.25, teleop: epa * 0.55, endgame: epa * 0.2, start: epa, max: epa + 4, percentile: Math.min(0.99, Math.max(0.01, 0.5 + (epa - 22) / 25)), worldRank: null, worldCount: null },
      record: { wins, losses, ties: 0, count: wins + losses, winrate: wins / (wins + losses) },
    };
  }

  return {
    event: { key: DEMO_KEY, name: "Demo Regional (sample data)", start: null, end: null, location: "Demo City", year: new Date().getFullYear() },
    teams,
    rankings,
    matches,
    statbotics: { teamEvents: sb, teamYears: sb, lastYears: {} },
  };
}
