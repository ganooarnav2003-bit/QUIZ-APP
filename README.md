# QuizLive

A live quiz web app: build a quiz, **set a timer for each question**, show a **QR code**, and everyone plays on their own phone — no app, no sign-up. Zero dependencies (Node 18+).

## Run
```bash
npm start            # http://localhost:3000   (PORT=8080 npm start to change)
npm test             # end-to-end smoke test
```
The server prints your Wi-Fi address (e.g. `http://192.168.1.20:3000`). **Open the host page using that address** (not `localhost`) so the QR code works for phones on the same network. For remote players, deploy anywhere that runs Node (Render, Railway, Fly.io, a VPS) and open the public URL — the QR then works from anywhere. Use "Set address…" in the lobby to override the link.

## How it works
1. **Host** – create a quiz (2–6 options per question, per-question timer 5 s–5 min, standard/double/no points, True/False shortcut). Quizzes are stored in your browser; import/export as JSON.
2. Click **Host live** → a QR code + 6-digit PIN appear. Players scan, enter a name and wait in the lobby.
3. **Start** → each question runs on a server-side countdown (host can +10 s, reveal early, or end). It auto-reveals when time runs out or everyone has answered.
4. **Scoring** – correct answers earn 50–100 % of the points depending on speed, plus a streak bonus. Live leaderboard, podium, per-question stats and **CSV export** at the end.

Correct answers are never sent to players until the reveal; timing is enforced on the server. Games live in memory (restart clears them).

Bundled: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) in `public/qrcode.js`.
