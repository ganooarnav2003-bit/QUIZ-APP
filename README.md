# QuizLive

A live quiz web app: build a quiz, **set a timer for each question**, show a **QR code**, and everyone plays on their own phone — no app, no sign-up. No npm dependencies (Node 18+).

## Deploy on Vercel (5 minutes)
1. Push this repo to GitHub (done) and in Vercel choose **Add New → Project → import `QUIZ-APP`**. No build settings needed (Framework: *Other*).
2. In the project go to **Storage → Marketplace → Upstash Redis** (free plan) → create a database and connect it to the project. That injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`) automatically.
3. **Redeploy** (Deployments → ⋯ → Redeploy) so the env vars are picked up. Open your `https://…vercel.app` URL as host — the QR code points to it and works from any phone, anywhere.

Without the database the API answers *"Storage not configured"* (serverless functions can't keep game state in memory).

Notes: players poll about once per second, so a 50-player game for 30 minutes is roughly 90k Redis commands — fine for a few games a month on the free plan; use a paid plan for heavy use.

## Run locally
```bash
npm start            # http://localhost:3000   (PORT=8080 npm start to change)
npm test             # local + simulated-Vercel/Redis end-to-end tests
```
Locally state is kept in memory (no database needed). Open the host page using the Wi-Fi address the server prints (not `localhost`) so the QR code works for phones on your network.

## How it works
1. **Host** – create a quiz (2–6 options per question, per-question timer 5 s–5 min, standard/double/no points, True/False shortcut). Quizzes are stored in your browser; import/export as JSON.
2. Click **Host live** → a QR code + 6-digit PIN appear. Players scan, enter a name and wait in the lobby.
3. **Start** → each question runs on a server-side countdown (host can +10 s, reveal early, or end). It auto-reveals when time runs out or everyone has answered.
4. **Scoring** – correct answers earn 50–100 % of the points depending on speed, plus a streak bonus. Live leaderboard, podium, per-question stats and **CSV export** at the end.

Correct answers are never sent to players until the reveal; timing is enforced on the server with lazy deadlines (no background timers, so it works on serverless). Games expire after 6 hours.

Bundled: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) in `public/qrcode.js`.
