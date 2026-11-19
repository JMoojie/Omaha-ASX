# Omaha ASX — Buffett value-investing game

A long-term ASX stock-picking game built on Warren Buffett's ideas: buy wonderful businesses at sensible prices, hold them for years, and sell only when the price is silly or the business breaks.

Everything here runs on **free tiers only**:

| Piece | What it does | Free allowance |
|---|---|---|
| GitHub | Stores the code | Free (a private repo is fine) |
| Cloudflare Worker + static assets | Hosts the game, saves your progress, fetches prices on a schedule | 100,000 requests/day; static files are free and unlimited |
| Cloudflare KV | Stores your saved game and the price list | 100,000 reads and 1,000 writes per day |
| Alpha Vantage key | Share prices (`CBA.AX`) | 25 requests/day |
| EODHD key | Share prices (`CBA.AU`) and the ASX 200 index (`AXJO.INDX`) | 20 requests/day |

**How fast prices refresh:** the server stays just under both free limits, so it fetches about **42 prices every weekday evening**. Your holdings and watchlist come first and refresh daily. The rest of the ASX 200 refreshes about once a week. If Alpha Vantage doesn't return a price for a stock, EODHD tries it instead.

---

## Setup (about 15 minutes, no coding)

### 1. Get your two free data keys
- **Alpha Vantage:** go to <https://www.alphavantage.co/support/#api-key>, enter your email, and the key is shown straight away.
- **EODHD:** register at <https://eodhd.com>. Your API key is on your account dashboard.

### 2. Put the code on GitHub
1. Sign in at <https://github.com>, then click **New repository**. Name it `omaha-asx`. It can be Private.
2. On the new repo page, click **uploading an existing file**. Drag in **everything inside** this folder (`public/`, `src/`, `wrangler.jsonc`, `package.json`, `README.md`, `.gitignore`), then click **Commit changes**.

### 3. Create the storage (KV namespace)
1. Sign up free at <https://dash.cloudflare.com>.
2. Go to **Storage & Databases → KV → Create**. Name it `omaha-asx`.
3. Copy the **Namespace ID**.
4. Back on GitHub, open `wrangler.jsonc`, click the ✏️ pencil, and replace `PASTE_YOUR_KV_NAMESPACE_ID_HERE` with your ID. Commit.

### 4. Deploy from GitHub
1. In Cloudflare, go to **Workers & Pages → Create → Import a repository**. Connect GitHub and pick `omaha-asx`.
2. Leave the build settings as they are (the deploy command is `npx wrangler deploy`) and click **Deploy**.
3. From now on, every change you commit to GitHub redeploys automatically.

### 5. Add your secrets
In Cloudflare, open the `omaha-asx` Worker, then go to **Settings → Variables and Secrets → Add**. Add each of these as type **Secret**:

| Name | Value |
|---|---|
| `APP_PIN` | Any passphrase you choose. It protects your saved game. |
| `AV_KEY` | Your Alpha Vantage key |
| `EODHD_KEY` | Your EODHD key |

Click **Deploy** to apply.

### 6. Play
- Open `https://omaha-asx.<your-subdomain>.workers.dev` and enter your PIN once on each device.
- **Phone:** open the same link, then use **Share → Add to Home Screen**. It opens full-screen like an app.
- **Bring over your progress from the Claude version:** there, go to **Settings → Copy my save**. Here, paste it into **Settings → Backup** and click **Restore from box**.

---

## How the price schedule works
- **When it runs:** every 15 minutes from 06:00 to 12:45 **UTC**, Monday to Friday. That's 5pm–11:45pm in Sydney during daylight saving, or 4pm–10:45pm in winter, so it always runs after the ASX closes. Change it in `wrangler.jsonc` under `triggers.crons`.
- **What each run does:** up to 2 Alpha Vantage calls (13 seconds apart, under their 5-per-minute limit) and up to 3 EODHD calls, then a single save to storage.
- **Manual fetch:** the **⚡ Fetch a batch now** button on the "Update prices" screen runs a batch straight away. It uses part of the same daily allowance.
- **Getting new prices into the game:** the game pulls new prices whenever it's open, and every 10 minutes while it stays open.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "APP_PIN secret is not set" | Add the `APP_PIN` secret (step 5) and redeploy. |
| The PIN keeps being asked for | The PIN you type must exactly match the `APP_PIN` secret. |
| No prices after an evening | Check **Workers → omaha-asx → Logs**, and the "Last run notes" on the game's Update prices screen. Usually a key is missing or mistyped. |
| Deploy fails mentioning KV | The namespace ID in `wrangler.jsonc` is missing or wrong (step 3). |
| A company never gets a price | Neither free source covers that code. Use the paste box on the Update prices screen. |

## Local development (optional)
```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in your keys
npm run dev                      # http://localhost:8787
# trigger the scheduler locally:
curl "http://localhost:8787/__scheduled?cron=*/15+6-12+*+*+1-5"
```

## Files
- `public/index.html`: the whole game. It also runs as-is inside Claude, where it saves to Claude instead of your Worker.
- `src/worker.js`: the web routes (`/api/state`, `/api/prices`, `/api/sync`) and the schedule.
- `src/core.js`: the price fetching and free-quota budgeting.
- `src/asx200.js`: the ASX 200 code list. The index rebalances quarterly, so edit it when that happens.

*An educational game, not financial advice.*
