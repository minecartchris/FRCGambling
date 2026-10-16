// The Blue Alliance API v3: schedules, scores, rankings, team names.
import { getJson } from "./fetcher.js";

const BASE = "https://www.thebluealliance.com/api/v3";
const COMP_ORDER = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
const COMP_NAME = { qm: "Qual", ef: "Eighth", qf: "Quarter", sf: "Semi", f: "Final" };

export const tbaEnabled = () => Boolean(process.env.TBA_API_KEY);

export const tba = (path, ttlMs) => getJson(BASE + path, { headers: { "X-TBA-Auth-Key": process.env.TBA_API_KEY }, ttlMs });

const num = (key) => String(key).replace(/^frc/, "");

export async function tbaEvents(year) {
  const events = await tba(`/events/${year}/simple`, 30 * 60_000);
  return events.map((e) => ({
    key: e.key,
    name: e.name,
    start: e.start_date,
    end: e.end_date,
    location: [e.city, e.state_prov, e.country].filter(Boolean).join(", "),
  }));
}

export function matchLabel(level, set, number) {
  if (level === "qm") return `Qual ${number}`;
  if (level === "f") return `Final ${number}`;
  return `${COMP_NAME[level] || level} ${set}-${number}`;
}

export async function tbaEvent(key) {
  const [info, teams, matches, rankings] = await Promise.all([
    tba(`/event/${key}/simple`, 30 * 60_000),
    tba(`/event/${key}/teams/simple`, 30 * 60_000),
    tba(`/event/${key}/matches/simple`, 45_000),
    tba(`/event/${key}/rankings`, 60_000).catch(() => null),
  ]);

  const rankByTeam = {};
  for (const r of rankings?.rankings || []) {
    rankByTeam[num(r.team_key)] = {
      rank: r.rank,
      wins: r.record?.wins ?? 0,
      losses: r.record?.losses ?? 0,
      ties: r.record?.ties ?? 0,
      played: r.matches_played ?? null,
    };
  }

  return {
    event: {
      key: info.key,
      name: info.name,
      start: info.start_date,
      end: info.end_date,
      location: [info.city, info.state_prov, info.country].filter(Boolean).join(", "),
      year: info.year,
    },
    teams: teams.map((t) => ({ id: String(t.team_number), name: t.nickname || `Team ${t.team_number}`, location: [t.city, t.state_prov, t.country].filter(Boolean).join(", ") })),
    rankings: rankByTeam,
    matches: convertMatches(matches),
  };
}

export function convertMatches(matches) {
  return (matches || []).map((m) => {
    const red = m.alliances.red;
    const blue = m.alliances.blue;
    const played = red.score >= 0 && blue.score >= 0 && (m.actual_time != null || m.winning_alliance !== "" || red.score + blue.score > 0);
    return {
      key: m.key,
      compLevel: m.comp_level,
      elim: m.comp_level !== "qm",
      label: matchLabel(m.comp_level, m.set_number, m.match_number),
      order: COMP_ORDER[m.comp_level] * 10000 + m.set_number * 100 + m.match_number,
      time: m.actual_time ?? m.predicted_time ?? m.time ?? null,
      played,
      red: { teams: red.team_keys.map(num), score: played ? red.score : null },
      blue: { teams: blue.team_keys.map(num), score: played ? blue.score : null },
    };
  });
}
