# FRC Match Predictor

Who will win an FRC match, and what will the winning score be?

- **Win probability gauge**: a semi-circular gauge with Red's chance on the left and Blue's on the right. The needle swings toward the favorite.
- **Predicted winning score**, both alliances' predicted scores, and an ~80% range.
- **Historical data**: Statbotics EPA (robot scoring strength, plus the auto/teleop/endgame breakdown), season and last-season win/loss records.
- **Today's matches**: every completed match at the event updates team ratings, and the latest day of play is weighted most. Live events refresh every 60 seconds.
- **Jev AI**: the [Jev decision model](https://jevmodel.net/docs) gets all of the above as context and answers two multiple-choice questions: who wins, and which score band the winner lands in. Its answer is blended with the stats model.
- **Personal bias sliders** for every team, from -100 to +100, saved in your browser.
- **All matches** (upcoming, completed, filter by team). Each completed match shows whether the pre-match pick was right.
- **Team profiles**: rank, record, rating trend, a score chart, EPA breakdown, upcoming matches, and results.
- **Over / under**: set a line for the winning score, either alliance's score, or total points, and see the chance it goes over or under, with a ladder of nearby lines.
- **Best bets**: the event's upcoming matches ranked by confidence (Lock / Strong / Lean / Toss-up), each with how often picks at that confidence actually won.
- **Are the win % honest?**: a chart comparing predicted chances with how often favorites really won, for this event, the last 60 events, and the live record (stats and Jev).
- **Score accuracy**: every completed match is re-predicted using only earlier information. The panel shows the average score miss, the share within ±25 and ±5 points, and how the miss shrinks from early to late in the event.
- **Live track record**: the last prediction before each match (stats and Jev) is saved and graded when the score posts, including whether newer predictions beat older ones.
- **Auto-tuning**: once a day the server replays the 60 most recent finished events and keeps the settings with the smallest score miss. Tuned settings survive restarts.

## How accurate can it get?

Measured on real 2026 events:

| | Avg miss per alliance | Within ±25 |
|---|---|---|
| Original model (164 regular-season events) | 59.2 | 30% |
| + team history from earlier events + tuning | 52.5 | 35% |
| Hindsight floor (fit with every result of the event known) | 33.3 | 50% |

Two more findings from the same data:

- **Score ranges were too narrow.** Only 63% of real scores landed inside the model's "80%" range. The spread is now widened (auto-tuned, about 1.35–1.5×) so the ranges, over/under odds, and win percentages are honest. The winning score is now predicted as the middle of the possible outcomes rather than the larger of the two alliance predictions, since the winner is usually the alliance that had the better day (miss 55.8 → 54.1).
- **Penalties aren't worth modeling separately.** They average 5 of 198 points per alliance, and 62% of alliances receive none. Fitting on penalty-free scores changed the miss by 0.1 points.

Average alliance score in that set was 185. Even in hindsight a typical score lands about 33 points from the fit, because robots break, penalties happen, and game pieces bounce. Being within ±25 most of the time is a realistic aim, but no model can do it every match, and ±5 is mostly luck.

## How the prediction works

1. **Prior**: each team starts at its Statbotics EPA entering the event. If that's unavailable, it starts at its OPR from earlier events this season, with the latest event weighted most (from TBA, cached in `DATA_DIR`).
2. **Update**: a ridge regression on this event's alliance scores pulls ratings from the prior toward what each team actually scores. Prior strength and per-day decay are auto-tuned.
3. **Form**: a small edge from season win rate, at most ±4% of an alliance score.
4. **Bias**: a +100 slider adds 35% of an average team's points to that team.
5. **Win probability**: `P(red) = Φ(margin / σ)`, where σ comes from how far real scores at this event landed from the fit.
6. **Jev** (optional): the final number is `(1 − JEV_WEIGHT) × stats + JEV_WEIGHT × Jev`.

The model lives in `public/lib/model.js`. The browser and server share it, so sliders update instantly.

## Configuration

| Variable | Needed | Purpose |
|---|---|---|
| `TBA_API_KEY` | Recommended | The Blue Alliance read key (free at thebluealliance.com/account). Without it the app falls back to Statbotics for schedules. |
| `JEV_API_KEY` | Optional | Jev key: a Vercel AI Gateway key (`vck_…`) or a TypeSafe key. The endpoint is picked automatically. Without it only the stats model runs. |
| `JEV_WEIGHT` | Optional | Jev's share of the blend, 0–1 (default `0.5`). |
| `JEV_MODEL` / `JEV_API_URL` | Optional | Override the model or endpoint. Defaults: `typesafe-ai/jev` at `ai-gateway.vercel.sh/typesafe` for gateway keys, `jev-latest` at `jevmodel.net` for TypeSafe keys. |

The app writes to `DATA_DIR` (`/data` on WebManager, `./data` locally): tuned settings (`tuning.json`), the live prediction log (`predictions.json`), and a cache of finished events. WebManager backs `/data` up before each restart.

If neither TBA nor Statbotics returns data, the app shows a clearly labeled demo event so the UI still works.

## Deploy on WebManager (webmgr.dev)

The repo already follows the [WebManager app contract](https://github.com/coolguy1333/WebManager/blob/main/docs/APP_HOSTING.md): it has a `Dockerfile` and `webmanager.json`, listens on `$PORT`, runs as a non-root user, serves health at `/api/health`, and handles `SIGTERM`.

1. Push this folder to a Git repository.
2. In WebManager, add the repository under **Sources** and choose **Deploy as an app**.
3. Open the app's **Variables** page and paste `TBA_API_KEY` and, optionally, `JEV_API_KEY`. Both are stored encrypted.

Never commit a `.env` file. WebManager refuses to deploy a folder that has one.

## Run locally

Requires Node 20+. There are no npm dependencies.

1. Copy `.env.example` to `.env` and fill in your keys. `.env` is gitignored.
2. Run `npm run dev`, which loads `.env` automatically.

Then open http://localhost:8080. Run the tests with `npm test`.
