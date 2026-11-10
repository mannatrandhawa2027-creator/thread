# Thread - See it. Make it.

An AI-powered knitting and crochet pattern generator for beginners.
Upload a photo of something you love, tell Thread your preferences, and get a
personalized, beginner-friendly pattern with every step explained.

Live site: https://threadknits.in

## What runs where

- **Frontend (this repo, live):** `index.html`, `styles.css`, `app.js`, plus
  `assets/` and `vendor/`. A plain HTML/CSS/JS static site - no build step, no
  framework. Hosted on Surge and served at https://threadknits.in.
- **Backend (`Code.gs`):** the pattern/photo API. Runs on Google Apps Script
  under the owner's account, deployed as a web app. The browser calls it
  directly; it calls Google's Gemini API (free tier) with a fallback chain of
  models and returns the pattern as JSON.
- **Legacy files:** `server.js`, `generate.js`, `generate-pattern.js`,
  `health.js`, `package.json` and `.env.example` are from the first local
  Node build. They are kept for history; they are not what runs live.

## Keys and privacy

- No API keys or secrets are stored in this repo or sent to the browser. The
  Gemini key lives only in the Apps Script project's Script Properties.
- Photo analysis can be switched off by setting the Script Property
  `PHOTO_ANALYSIS=off`; the site then stops sending photos.
- The backend has daily request caps to protect the free-tier quota.

## Honest limits

- Patterns are written by AI and can still be wrong. The site tells users to
  make a small swatch first.
- The free tier can be slow or busy at times; the site shows an honest
  message instead of hanging forever.
