# TAAI piracy scanner

Finds public Telegram channels, groups and posts that look like they share
TAAI's paid courses, and lists them in /team > Piracy > Found for the team to
review. It never reports anything itself; notices are still sent by a person.

It needs a real Telegram account (Telegram doesn't let bots or websites search).
It runs once a day on GitHub Actions, logged into a spare account.

## Two ways to run it

- **From a computer, by hand (simplest).** Double-click
  `run-scanner.command` on a Mac once or twice a week. Setup below.
- **Automatically every day on GitHub Actions** (free, no computer needed).
  Setup further down. Skipped quietly until its secrets are added.

## Run it from a Mac

1. Get the spare SIM and API keys (see "What you need").
2. Copy the `piracy-scanner` folder to the Mac, double-click
   `run-scanner.command`. The first time it opens `.env`: fill in the five
   values (API id and hash, the spare number with +91, and the site's
   `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`), save, and double-click again.
3. It installs what it needs, then asks for the code Telegram sends to the
   spare phone (and the two-step password, if set). That login is saved in
   `taai-scanner.session` next to it, so later runs need nothing.
4. When it says "Done", open /team > Piracy > Found.

If macOS says it can't be opened (unidentified developer): right-click it >
Open > Open, once. Needs Python 3 (`python3 --version` in Terminal; if
missing, macOS offers to install it). Keep `.env` and `taai-scanner.session`
private: together they are a login to the spare account.

## What you need

1. **A spare SIM** with Telegram installed. Don't use anyone's personal
   number: if Telegram limits the account, nothing else is affected. Use the
   account normally for a few days before the first scan; brand-new accounts
   that start searching straight away get limited faster.
2. **Telegram API keys** for that account: log in at https://my.telegram.org
   with the spare number, open "API development tools", create an app (any
   name, platform "Other"). Note the `api_id` and `api_hash`.
3. The SQL for `piracy_reports` and `piracy_candidates` (end of
   `supabase/schema.sql`) run once.

No server: it runs on GitHub Actions (free), from
`.github/workflows/piracy-scanner.yml`, every day at 07:30 IST.

## Daily on GitHub Actions instead (optional)

1. **Log in once on any computer**, with the spare phone nearby:
   ```bash
   pip install telethon
   python piracy-scanner/login.py
   ```
   Enter the API id and hash, the spare number and the code Telegram sends.
   It prints a long text string: the saved login.
2. **Add five secrets** on GitHub: the taai2025/TAAI repository > Settings >
   Secrets and variables > Actions > New repository secret:
   - `TG_API_ID`, `TG_API_HASH`: from my.telegram.org
   - `TG_SESSION`: the string from step 1
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`: same as the site's `.env`
3. **Run it once by hand**: Actions tab > "Piracy scanner" > Run workflow.
   When it finishes, finds appear in /team > Piracy > Found.

The saved login string is as good as the account's password: keep it only in
the GitHub secret. GitHub secrets are never shown in logs, and the scanner
never prints channel names or links (the repository is public, so its Actions
logs are too). If Telegram ever logs the scanner out, the run fails with a
message saying so: run `login.py` again and replace `TG_SESSION`.

Running it on a computer instead also works: copy `.env.example` to `.env`,
fill it in, `pip install -r requirements.txt`, then `python scanner.py` (the
first run asks for the login code and saves `taai-scanner.session`).

## Changing what it searches for

/team > Piracy > Found > "Search terms": one term per line. Saved in the
database, read at the start of every run; no server access needed.

## Telegram Premium on the spare number

Optional, but it helps. Telegram's "search public posts" looks through posts
in every public channel, so it finds sale and promo posts in channels whose
name has nothing to do with TAAI (like "GATE ALL BRANCH" selling TAAI for
₹2,000). Every account gets a few of these searches free each day; Premium
gets more. The scanner uses at most 5 per run (`MAX_POST_SEARCHES`), only free
ones (it never pays Stars), so the rest of the day's searches stay
available in the app. It prints how many it used. It spends them on the
first 5 search terms in /team, so put the most useful terms at the top.

## How it decides something is a match

Each channel gets points: TAAI (including T*AI, T.A.A.I, TAA1, fancy fonts) or
"Manoj Kumar" in its name or description, posts mentioning TAAI, Learnyst file
names ("lyst…"), TAAI course or lesson titles, sale posts with a price, and
being linked from another match. 4 points or more = shown in /team. Channels
dismissed in /team stay dismissed; it only refreshes their numbers.

## Limits

- Private channels and invite-only groups can't be searched or read. Invite
  links seen in public posts are checked without joining (name and member
  count only).
- Posts that are only videos or files with no TAAI wording or file names
  won't match.
- Telegram limits how many usernames an account can look up per day; the
  scanner stops for the day if Telegram asks it to wait more than 5 minutes.
