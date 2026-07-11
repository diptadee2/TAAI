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

`index.html`, `courses.html`, `test-series.html`, `testimonials.html`, `contact.html`, `resources.html` — each listed in `PAGES` in `build.mjs`. `resources.html` fetches notes/lecture metadata at runtime from published Google Sheet CSVs (`sheets/` holds local snapshot templates, gitignored).

## Blog (added 2026-06-27)

Static, no backend/database. Source of truth is `content/blog/*.md` (frontmatter + Markdown).

- `build.mjs`'s `generateBlog()` reads those files and writes plain static HTML (no JSX/Babel involved) into the **source** `blog/` folder: `blog/index.html` (listing) and `blog/<slug>/index.html` (each post) — written to source rather than `dist/` specifically so the source-serving dev server can preview it like every other page. The generic asset-copy step in `build()` then carries `blog/` into `dist/` for the real deploy.
- These generated files (`blog/index.html`, `blog/*/`) and the root `sitemap.xml` are gitignored — they're build artifacts regenerated from `content/blog/`, same logic as `dist/` itself not being committed.
- Visual design is shared via `blog/blog.css` (extracted design tokens/nav/footer from the main pages, plus blog-specific styles matching the site's offer-card visual language — gradient hero blobs, gradient `<em>` emphasis, top-strip+icon-badge cards) and `blog/blog.js` (vanilla JS: mobile hamburger menu, scroll progress, back-to-top, fade-in reveal — a deliberately simplified stand-in for the React pages' nav, since duplicating the full stateful Nav component's hover-pill/signin-cycle animations wasn't worth it for content pages).
- `sitemap.xml` is generated dynamically (was a hand-maintained static file before) and includes every post automatically.
- `/admin` is Decap CMS (`admin/index.html` + `admin/config.yml`), backend `git-gateway` — a non-technical writer logs in (Netlify Identity, optionally via Google as an external provider) and publishing commits a Markdown file straight to `content/blog/`, which triggers a normal Netlify rebuild.
- **Known gotcha**: Decap CMS resolves `config.yml` as a relative URL. Visiting `/admin` without a trailing slash makes the browser resolve it against `/` instead of `/admin/`, 404ing regardless of browser — fixed via `<base href="/admin/">` in `admin/index.html`. Don't remove that tag.
- Netlify Identity + Git Gateway + the Google login provider are dashboard-only settings, not something committable — and Identity login only works on a real deployed domain, never on `localhost`.

## Git remotes

Push reaches **both** `github.com/taai2025/TAAI` (primary) and `github.com/diptadee2/TAAI` (the user's personal mirror) via origin's dual-pushurl config. Plain `git push` is sufficient — don't add `--force` or push to only one remote unless asked.

## Known gotchas worth not re-discovering

- **Chromium DOM-node leak**: animating `transform` or `box-shadow` directly on an element that *also* has both `box-shadow` and `border-radius` causes an unbounded detached-node leak (confirmed via CDP `Performance.getMetrics`). Animate a wrapper or pseudo-element instead, leave the shadow+radius element itself unanimated.
- **WebGL/Canvas effects are expensive per-tab** (measured via renderer+GPU process RSS, not JS heap — heap snapshots show nothing here): a `gsap`-driven Canvas2D effect cost ~150-200MB/tab from its continuous ticker; an `ogl`-based WebGL shader background cost ~300MB from context creation itself, independent of resolution. A zero-dependency Canvas2D effect with no continuous external library ticker (`DotField` in `courses.html`) showed no measurable cost. Prefer that pattern if a future visual effect request comes in.
- **Dev-server-only memory growth** from repeated live Babel recompilation during active navigation testing is expected and not a leak (confirmed via heap-snapshot diffing) — it does not affect production, since Netlify serves precompiled `dist/`.
- **Favicon**: the 16×16 frame inside any `.ico` built via ImageMagick gets forced to 1-bit alpha regardless of source quality — that's why standalone `favicon-16.png`/`favicon-32.png` exist as preferred `<link rel="icon" type="image/png">` tags ahead of the `.ico` fallback.
