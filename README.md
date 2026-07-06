# Sukoon

A gentle daily studio — intentions, journal, breathing, pocket. Built as a
single React component; this folder wraps it in a minimal Vite project so
it can be hosted on GitHub Pages.

## What changed from the Claude artifacts

Claude's chat environment gives artifacts a `window.storage` API for saving
data. That API doesn't exists in a normal browser, so `src/App.jsx` starts
with a small polyfill that backs the same calls with `localStorage`
instead. Everything else is unchanged — data still autosaves, still lives
only in the visiting browser (one person's data isn't visible to anyone
else, but it's also **per-browser**, not per-person: it won't follow you
across devices or browsers unless you use the Export/Import backup
buttons already built into the app).

## 1. Run it locally (optional, but good to check first)

You'll need [Node.js](https://nodejs.org) (18+) installed.

```bash
cd sukoon-app
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`) and confirm it
works.

## 2. Push it to GitHub

```bash
cd sukoon-app
git init
git add .
git commit -m "Sukoon"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

(Create the empty repo on GitHub first, without a README, so the push has
somewhere to land.)

## 3. Set the base path

Open `vite.config.js` and set `base` to match your repo name exactly:

```js
base: '/<your-repo>/',
```

If you're deploying to a *user/organization* Pages site named
`<your-username>.github.io`, set `base: '/'` instead.

## 4. Deploy to GitHub Pages

The project already has a `gh-pages` deploy script wired up:

```bash
npm install        # if you haven't already
npm run deploy
```

This builds the app and pushes the result to a `gh-pages` branch.

Then on GitHub: go to **Settings → Pages**, and under "Build and
deployment" choose **Deploy from a branch**, branch `gh-pages`, folder
`/ (root)`. Save. Your site will be live at:

```
https://<your-username>.github.io/<your-repo>/
```

(GitHub Pages can take a minute or two to publish after the first push.)

## Alternative: GitHub Actions (auto-deploy on every push)

If you'd rather not run `npm run deploy` by hand each time, GitHub can
build and publish automatically whenever you push to `main`. Ask and I
can add the workflow file for that instead.

## Notes

- Sounds, breathing, notifications, and everything else work the same as
  in the Claude preview — nothing else needed to change.
- If you ever want real cross-device sync (not just per-browser storage),
  that needs a small backend — a good next step if this grows beyond one
  browser.
