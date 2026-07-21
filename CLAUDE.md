# TAAI website — project context

GATE DA 2027 exam-prep marketing site for TAAI (live at taai.live; LMS is a separate app at learn.taai.live, not in this repo).

## Tech stack

- Plain HTML + inline `<style>` + JSX, no bundler. Each of the 6 main pages is fully self-contained: nav, footer, and all components are copy-pasted JSX inside that page's own `<script type="text/babel">` block.
- `build.mjs` precompiles the JSX (via `@babel/core` + `@babel/preset-react`) into plain JS and writes the result to `dist/`, which is what Netlify deploys (`netlify.toml`: `publish = "dist"`).
- Local dev serves the **source root directly**, not `dist/` — source pages still have Babel Standalone (`<script type="text/babel">`) and load React/ReactDOM from a CDN, so they transpile live in-browser. This means editing a page and refreshing works with no build step, but it also means anything that only exists in `dist/` (generated output) is invisible to the dev server unless it's also written into source.

## Commands

- `npm run build` — compiles pages + regenerates the blog + sitemap into source, then copies everything to `dist/`.
- `npm run watch` — same, plus rebuilds a page's compiled output when its source file changes.
- Local preview: a static server pointed at the **project root** (not `dist/`), typically on port 8080.

## Pages

`index.html`, `gate-da-courses.html`, `gate-da-test-series.html`, `gate-da-toppers.html`, `contact.html`, `gate-da-free-notes.html`, `progress.html` — each listed in `PAGES` in `build.mjs`. Clean URLs (`/gate-da-courses`, etc.) are handled by redirects in `netlify.toml`, with 301s from the old short names (`/courses`, `/test-series`, `/testimonials`, `/resources`) and from `.html` extensions so old links don't break. `gate-da-free-notes.html` fetches notes/lecture metadata at runtime from published Google Sheet CSVs (`sheets/` holds local snapshot templates, gitignored). `progress.html` is the one exception to the "JSX per page" rule below — see the Progress tracker section.

## Blog (added 2026-06-27)

Static, no backend/database. Source of truth is `content/blog/*.md` (frontmatter + Markdown).

- `build.mjs`'s `generateBlog()` reads those files and writes plain static HTML (no JSX/Babel involved) into the **source** `blogs/` folder: `blogs/index.html` (listing) and `blogs/<slug>/index.html` (each post) — written to source rather than `dist/` specifically so the source-serving dev server can preview it like every other page. The generic asset-copy step in `build()` then carries `blogs/` into `dist/` for the real deploy.
- These generated files (`blogs/index.html`, `blogs/*/`) and the root `sitemap.xml` are gitignored — they're build artifacts regenerated from `content/blog/`, same logic as `dist/` itself not being committed.
- Visual design is shared via `blogs/blog.css` (extracted design tokens/nav/footer from the main pages, plus blog-specific styles matching the site's offer-card visual language — gradient hero blobs, gradient `<em>` emphasis, top-strip+icon-badge cards) and `blogs/blog.js` (vanilla JS: mobile hamburger menu, scroll progress, back-to-top, fade-in reveal — a deliberately simplified stand-in for the React pages' nav, since duplicating the full stateful Nav component's hover-pill/signin-cycle animations wasn't worth it for content pages).
- `sitemap.xml` is generated dynamically (was a hand-maintained static file before) and includes every post automatically.
- `/admin` is Decap CMS (`admin/index.html` + `admin/config.yml`), backend `git-gateway` — a non-technical writer logs in (Netlify Identity, optionally via Google as an external provider) and publishing commits a Markdown file straight to `content/blog/`, which triggers a normal Netlify rebuild.
- **Known gotcha**: Decap CMS resolves `config.yml` as a relative URL. Visiting `/admin` without a trailing slash makes the browser resolve it against `/` instead of `/admin/`, 404ing regardless of browser — fixed via `<base href="/admin/">` in `admin/index.html`. Don't remove that tag.
- Netlify Identity + Git Gateway + the Google login provider are dashboard-only settings, not something committable — and Identity login only works on a real deployed domain, never on `localhost`.

## Progress tracker (`/progress`, added 2026-07-21)

A day-by-day study schedule tracker at `taai.live/progress`, open to any student (no LMS/enrollment check — this is intentionally separate from `learn.taai.live`). First real backend/database this repo has ever had; everything else in this site is static.

- **Frontend**: `progress.html` + `progress.js` — vanilla JS, no React/Babel/JSX (unlike the 6 main pages). `progress.js` renders everything by building HTML strings and setting `innerHTML`, not a framework.
- **Backend**: Supabase (Postgres) accessed only through Netlify Functions in `netlify/functions/` — the frontend never talks to Supabase directly. `lib/supabase.js` and `lib/csv.js` hold shared helpers. Functions: `register`, `schedule`, `progress`, `complete-task`, `streak`, `subject-progress`, and `sync-schedule` (scheduled, 3 AM IST daily per `netlify.toml`).
- **Student identity**: cookie only (`taai_user`, base64-encoded JSON, 365-day expiry), no passwords/auth. `register.js` looks up-or-creates by email.
- **Schedule data flow**: a Google Sheet tab (`Date | <Subject columns...>`, dates as `DD/MM/YYYY`, one cell = one task, subject columns freeform/auto-detected) → published to web as CSV → `GOOGLE_SHEET_CSV_URL` env var → `sync-schedule.js` cron pulls it and fully replaces `schedule_tasks` for every date the sheet covers (so cleared cells actually disappear). `sheets/schedule.csv` is a local snapshot of the real schedule (same gitignored-templates convention as `sheets/pricing.csv` etc.) — when given a new month's schedule (as a PDF or similar), convert it to this same CSV format for the user to paste into the Sheet.
- **Streak** (`streak.js`) and **subject-progress** (`subject-progress.js`) are both computed from the *entire* schedule history server-side, not from whatever month the client currently has loaded — a month-scoped version would make progress look like it resets every time the student navigates months, since e.g. a subject can span many months and a streak must span backward past the currently-viewed month.
- **Local dev/testing needs Docker** — the plain static server (`npx serve`) can't run `/api/*` Netlify Functions. Full loop: `npx supabase start` (local Postgres+API, ~9GB of images), `npx supabase db reset` (applies `supabase/migrations/`), re-seed via the sync logic against `sheets/schedule.csv`, then `npx netlify-cli dev --port 8080` (not plain `serve`) so `/api/*` resolves. `netlify.toml` has a `[dev] publish = "."` block specifically so `netlify dev` serves source (live JSX transpile) like the plain server does, not `dist/`. Safe to fully tear down when not actively testing (`supabase stop --no-backup` + `docker rmi` the `public.ecr.aws/supabase/*` images) — everything is recreatable from `supabase/migrations/` + `sheets/schedule.csv`.
- **Production is not set up yet** — as of this writing there is no real cloud Supabase project. Manual one-time steps still needed before this works live: create a Supabase project and run `supabase/schema.sql` in its SQL editor, publish the real schedule Google Sheet tab as CSV, and set `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `GOOGLE_SHEET_CSV_URL` in Netlify's dashboard env vars.

## Git remotes

Push reaches **both** `github.com/taai2025/TAAI` (primary) and `github.com/diptadee2/TAAI` (the user's personal mirror) via origin's dual-pushurl config. Plain `git push` is sufficient — don't add `--force` or push to only one remote unless asked.

## Known gotchas worth not re-discovering

- **Chromium DOM-node leak**: animating `transform` or `box-shadow` directly on an element that *also* has both `box-shadow` and `border-radius` causes an unbounded detached-node leak (confirmed via CDP `Performance.getMetrics`). Animate a wrapper or pseudo-element instead, leave the shadow+radius element itself unanimated.
- **WebGL/Canvas effects are expensive per-tab** (measured via renderer+GPU process RSS, not JS heap — heap snapshots show nothing here): a `gsap`-driven Canvas2D effect cost ~150-200MB/tab from its continuous ticker; an `ogl`-based WebGL shader background cost ~300MB from context creation itself, independent of resolution. A zero-dependency Canvas2D effect with no continuous external library ticker (`DotField` in `courses.html`) showed no measurable cost. Prefer that pattern if a future visual effect request comes in.
- **Dev-server-only memory growth** from repeated live Babel recompilation during active navigation testing is expected and not a leak (confirmed via heap-snapshot diffing) — it does not affect production, since Netlify serves precompiled `dist/`.
- **Favicon**: the 16×16 frame inside any `.ico` built via ImageMagick gets forced to 1-bit alpha regardless of source quality — that's why standalone `favicon-16.png`/`favicon-32.png` exist as preferred `<link rel="icon" type="image/png">` tags ahead of the `.ico` fallback.
- **Server-side "today" must be computed in IST, never naive `new Date()`**: Netlify Functions run on infrastructure with no guaranteed local timezone (effectively UTC). For roughly the first 5.5 hours of every IST calendar day, a naive `new Date().toISOString().slice(0,10)` silently returns *yesterday's* date by IST reckoning — bit us exactly this way in `streak.js` (a same-day tick wasn't counted). Use `todayIST()` in `netlify/functions/lib/supabase.js` (`Intl.DateTimeFormat` pinned to `Asia/Kolkata`) for any server-side calendar-date logic.
- **`@supabase/supabase-js` needs an explicit WebSocket transport**: `createClient()` eagerly constructs a Realtime client requiring a `WebSocket` constructor that isn't guaranteed across every Node/Lambda runtime a function might execute on — without it, every single request crashes. `lib/supabase.js` passes `realtime: { transport: ws }` (the `ws` npm package) to work around this; don't remove it even though nothing here actually uses realtime subscriptions.
- **Local Supabase (`supabase start`) doesn't auto-grant table privileges** the way a hosted project does — a table created via migration has no `service_role` GRANTs by default on the local CLI's Postgres image, so every query fails with "permission denied" even with correct credentials. `supabase/schema.sql` ends with explicit `GRANT SELECT, INSERT, UPDATE, DELETE ... TO service_role` — required for local dev to work at all, keep it even though hosted Supabase might not strictly need it.
- **`.fade-in` elements + a `fullPage` Playwright screenshot taken without scrolling can look like missing content** when they're actually present and correct — the IntersectionObserver-driven reveal hasn't fired yet for anything below the fold at capture time. Before treating a screenshot gap as a real bug, either scroll through first or run `document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'))` to force-reveal everything, then re-screenshot.
- **Regenerating a `.fade-in` element's `innerHTML` replays its entrance animation from scratch**, even if the only actual change was a number. Hit this repeatedly in `progress.js` (streak card, subject-breakdown, heatmap all did this on every task toggle). Fix pattern used throughout: patch the specific value in place (`el.textContent = ...`, `el.style.width = ...`, `el.setAttribute('data-level', ...)`) instead of regenerating and reassigning a `.fade-in` ancestor's `innerHTML`.
