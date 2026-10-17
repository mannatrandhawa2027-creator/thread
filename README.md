# Thread - See it. Make it.

An AI-powered knitting and crochet pattern generator for beginners.
Upload a photo of something you love, tell Thread your preferences, and get a
personalized, beginner-friendly pattern - with every stitch explained.

Built as a plain HTML/CSS/JS frontend plus a tiny zero-dependency Node server.
No build step, no npm packages, no framework.

---

## Quick start (local)

```bash
node server.js
# open http://localhost:3000
```

Node 18 or newer. No `npm install` needed - there are no dependencies.

With no API key set, Thread uses a free keyless AI endpoint
(text.pollinations.ai) so generation works out of the box. That endpoint is
**text-only**: patterns are generated from your written choices, and uploaded
photos are NOT analyzed. See below for full photo-based patterns.

## AI configuration (server-side, keys never exposed)

Set ONE of these environment variables and restart:

| Variable | Provider | Default model | Photo analysis |
|---|---|---|---|
| `OPENAI_API_KEY` | OpenAI | `gpt-4o` | yes |
| `ANTHROPIC_API_KEY` | Anthropic | `claude-sonnet-4-20250514` | yes |
| `GEMINI_API_KEY` | Google | `gemini-2.5-flash` | yes |

Optional overrides: `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`,
`KEYLESS_MODEL`, `PORT`.

Photo analysis needs the server version (Option A or B below). The static demo site
cannot hold a key safely, so it stays in text-only demo mode; to put a
vision-enabled version online, deploy Option A or B and set the key there.

With a key set, the reference photo is sent to the model (vision) and the
pattern is based on what it sees. Keys live only in the server environment;
the browser never sees them. Set `REQUIRE_API_KEY=1` to disable the keyless
fallback entirely - the app then shows exactly which config is missing.

## Deploy

### Option A - Render (recommended, free tier, keeps the server + keyless AI)

1. Push this folder to a GitHub repo (or use Render's "Deploy from public repo").
2. On render.com: New > Web Service > connect the repo.
3. Build command: *(leave blank)*. Start command: `node server.js`.
4. (Optional) Add `OPENAI_API_KEY` etc. under Environment for photo analysis.
5. Deploy. Render gives you `https://<name>.onrender.com`.

Render free services sleep after inactivity; the first visit may take ~30s to wake.

### Option B - Vercel (serverless)

This repo is Vercel-ready: `public/` is served statically and `api/*.js`
become serverless functions.

```bash
npm i -g vercel
vercel        # from this folder, follow the prompts
```

Set any API key in the Vercel dashboard under Settings > Environment Variables.
Note: Vercel's free request body limit (~4.5 MB) is fine because the app
downscales photos before upload.

### Option C - any static host (Netlify Drop, GitHub Pages, surge.sh)

Deploy the `public/` folder only. The app detects there is no server and calls
the free keyless AI endpoint directly from the browser (demo mode). Everything
works except photo analysis. The live demo at the URL we shipped uses this mode.

### Custom domain

- **Render:** Settings > Custom Domains > add your domain, then create the CNAME
  record it shows at your DNS provider.
- **Vercel:** Settings > Domains > add the domain, then point an A record to
  `76.76.21.21` (or CNAME to `cname.vercel-dns.com`).
- **surge.sh:** `surge public/ yourdomain.com`, then CNAME `yourdomain.com` to
  `na-west1.surge.sh` (surge prints exact instructions).

HTTPS is automatic on all three.

## Taking over the live demo deployment

The demo site is deployed on surge.sh under a deployment account managed by
your assistant (registered under an assistant-controlled mailbox). To own it
yourself: install surge (`npm i -g surge`), register with your own email,
run `surge public/ <your-choice>.surge.sh` from this folder, and (optionally)
ask for the old deployment to be torn down.

## Project structure

```
server.js               zero-dependency Node server (static + /api/*)
lib/generate.js         provider detection, prompt, vision calls, JSON repair
api/generate-pattern.js Vercel serverless wrapper (same logic)
api/health.js           health check for Vercel
public/                 the whole frontend (no build step)
  index.html  styles.css  app.js
  assets/hero.jpg
  vendor/jspdf.umd.min.js   PDF export, vendored so it works offline
```

## Honest feature status

- Home / create form / results / My Patterns (saved in the browser via localStorage, persist across visits, reopen/delete/re-download all supported): fully working.
- Validation with inline errors: working.
- Real AI generation: working - server mode with any of the 3 key providers
  (OpenAI, Anthropic, Gemini; photo analyzed via vision), or keyless
  fallback (text-only). The keyless path is live-tested end-to-end; the keyed
  provider paths are code-complete and syntax-checked but were not live-tested
  here (no key was available).
- Photo upload with preview/replace/remove: working; photo informs the pattern
  only when a vision-capable API key is configured.
- PDF download of the real generated pattern: working (client-side jsPDF).
- AI-may-contain-errors disclaimer and scrap-yarn swatch reminder: shown on
  every pattern.
