# ClinicOS — Deployment Guide

## Files
- `clinicos-server.js` — the server (deploy this to Railway)
- `package.json` — needed for Railway to detect Node
- `clinicos-pms.html` — the app (host anywhere, or open locally)
- `clinicos-schema.sql` — run this in Supabase first

---

## Step 1 — Supabase schema

1. Go to [supabase.com](https://supabase.com) → your project → **SQL Editor**
2. Paste the contents of `clinicos-schema.sql` and click **Run**
3. You'll see tables appear in the left panel

---

## Step 2 — Deploy server to Railway

1. Create a free account at [railway.app](https://railway.app)
2. Click **New Project → Deploy from GitHub repo**
3. Push `clinicos-server.js` and `package.json` to a GitHub repo first:
   ```
   git init
   git add clinicos-server.js package.json
   git commit -m "ClinicOS server"
   gh repo create clinicos-server --public --push --source=.
   ```
   (or create a repo manually on github.com and drag the files in)
4. In Railway: connect that repo, it auto-detects Node and deploys
5. Go to your service → **Variables** tab, add these:

| Variable | Value |
|---|---|
| `CLOUDRX_CLIENT_ID` | Your CloudRx client ID |
| `CLOUDRX_CLIENT_SECRET` | Your CloudRx client secret |
| `CLOUDRX_CLINIC_CODE` | Your clinic code |
| `CLOUDRX_ENV` | `sandbox` or `production` |
| `SUPABASE_URL` | `https://oxvnjsooxxjwosozipgd.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase **service_role** key (not the publishable key) |

6. Railway will redeploy automatically — you'll get a URL like:
   `https://clinicos-server-production.up.railway.app`

> **Important**: Use the **service_role** key from Supabase (Settings → API → service_role), NOT the publishable/anon key. The service role key bypasses RLS and is safe to use server-side only.

---

## Step 3 — Connect the app

1. Open `clinicos-pms.html` in your browser
   - Host it on [tiiny.site](https://tiiny.site), GitHub Pages, or just open locally
2. Go to **Settings → CloudRx API**
3. Set **Server URL** to your Railway URL, e.g.:
   `https://clinicos-server-production.up.railway.app`
4. Click **Save & Connect** — it will auto-pull the environment and confirm credentials

That's it. Any user who opens the HTML file and points it at your Railway server will have full access — no credentials needed in the browser.

---

## Sharing with other users

Once hosted, just send them the HTML file (or host it too). They open it, go to Settings, paste the Railway URL, done.

Or if you host the HTML on a server too, they just open the URL — zero setup.

---

## Local development

```
CLOUDRX_CLIENT_ID=xxx CLOUDRX_CLIENT_SECRET=yyy CLOUDRX_CLINIC_CODE=zzz \
SUPABASE_URL=https://oxvnjsooxxjwosozipgd.supabase.co SUPABASE_SERVICE_KEY=xxx \
node clinicos-server.js
```
