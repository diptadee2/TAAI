-- TAAI Progress Tracker — Supabase schema (v4 spec)
-- Run this once in the Supabase SQL editor for the project used by
-- SUPABASE_URL / SUPABASE_SERVICE_KEY. Safe to re-run (IF NOT EXISTS guards).

-- Student identity
CREATE TABLE IF NOT EXISTS students (
  email         TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT now()
);

-- Per-student pomodoro timer durations, so a customized setup follows a
-- student across devices/browsers instead of only living in one device's
-- localStorage (see pomo-settings.js, progress.js's applyPomoSettings).
-- Nullable — NULL means "never customized, use the client's defaults"
-- rather than baking DEFAULT_POMO_SETTINGS into the database itself.
ALTER TABLE students ADD COLUMN IF NOT EXISTS pomo_work_min INTEGER;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pomo_short_break_min INTEGER;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pomo_long_break_min INTEGER;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pomo_cycle_sessions INTEGER;

-- Schedule synced from Google Sheets daily
CREATE TABLE IF NOT EXISTS schedule_days (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date        DATE NOT NULL UNIQUE,
  synced_at   TIMESTAMP DEFAULT now()
);

-- Individual tasks per day per subject
CREATE TABLE IF NOT EXISTS schedule_tasks (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date        DATE NOT NULL,
  subject     TEXT NOT NULL,   -- e.g. "Linear Algebra", "AI (Logic)"
  task_text   TEXT NOT NULL,   -- e.g. "Mod 1: Lec 1, Case 4 & 5, Lec 2"
  position    INTEGER NOT NULL, -- order within the day (subject column index)
  UNIQUE (date, subject, position)
);

-- Student task completion
CREATE TABLE IF NOT EXISTS task_progress (
  email         TEXT REFERENCES students(email),
  date          DATE NOT NULL,
  subject       TEXT NOT NULL,
  task_text     TEXT NOT NULL,
  completed     BOOLEAN DEFAULT false,
  completed_at  TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT now(),
  PRIMARY KEY (email, date, subject, task_text)
);

-- Focus (pomodoro work-session) minutes per student, per week, for Focus
-- Mode's weekly leaderboard. Only completed sessions count, see
-- pomodoro-complete.js and progress.js's pomoTick (Skip doesn't record).
-- Keyed by (email, week_start) rather than a single running total per
-- student, so the leaderboard resets every week by construction: a new
-- week just means a new row starting from zero, no cron job needed to
-- zero anything out, and past weeks' totals are naturally preserved.
CREATE TABLE IF NOT EXISTS pomodoro_stats (
  email          TEXT REFERENCES students(email),
  week_start     DATE NOT NULL, -- Monday of the ISO week (IST), see weekStartIST()
  total_minutes  INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMP DEFAULT now(),
  PRIMARY KEY (email, week_start)
);

-- Completed work-session count per student, per day, for Focus Mode's
-- session dots ("N / cycle sessions") — persisted so a student's daily
-- progress toward a long break follows them across reloads/devices
-- instead of resetting to 0 on every page load, while still resetting
-- naturally at midnight IST since a new day is just a new row starting
-- from zero (same reset-by-construction pattern as pomodoro_stats'
-- week_start key, see the comment above it). Only genuine completions
-- count — see pomodoro-complete.js, which writes to this table and
-- pomodoro_stats together, since both are driven by the same "a work
-- session actually finished" event.
CREATE TABLE IF NOT EXISTS pomo_daily_sessions (
  email              TEXT REFERENCES students(email),
  date               DATE NOT NULL, -- IST calendar date, see todayIST()
  sessions_completed INTEGER NOT NULL DEFAULT 0,
  -- Added for the "highest hours today" leaderboard (tracker-data.js's
  -- fetchTodayLeaders) — sessions_completed alone can't rank by time, since
  -- work-phase duration is per-student customizable, so two students with
  -- the same session count can have very different actual minutes.
  total_minutes      INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMP DEFAULT now(),
  PRIMARY KEY (email, date)
);

-- Server-side mirror of the pomodoro timer's active/paused state, synced
-- on every meaningful client-side change (start/pause/skip/reset/phase-
-- advance — see savePomoActiveState in progress.js). This used to live
-- only in localStorage, invisible across devices — a student opening the
-- tracker on a second browser/device saw a fresh, unaware timer instead
-- of the session already running elsewhere. One row per student
-- (PRIMARY KEY email, not composite) since there's only ever one "current"
-- session regardless of how many devices might be open.
CREATE TABLE IF NOT EXISTS pomo_active_session (
  email              TEXT PRIMARY KEY REFERENCES students(email),
  mode               TEXT NOT NULL,          -- 'work' | 'break'
  running            BOOLEAN NOT NULL DEFAULT false,
  phase_end_at       BIGINT,                 -- ms epoch, matches the client's Date.now()-based deadline model; null while paused
  seconds_left       INTEGER,                -- authoritative only while paused (running=false) — no ticking deadline to derive it from otherwise
  total_seconds      INTEGER,
  completed_sessions INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMP DEFAULT now()
);

-- phase_started_at: server-assigned (never client-supplied) the moment
-- pomo-active.js first sees a given phase begin — see the "new phase"
-- detection there. credited_through: the phase_end_at value (if any)
-- pomodoro-complete.js has already credited for this student, so a repeat
-- completion call for the same phase (two tabs mirroring one real session,
-- or a retried request) is a no-op instead of double-crediting. Both back
-- pomodoro-complete.js's server-side verification that a claimed session
-- actually ran, instead of trusting whatever minutes value a request sends
-- — see credit_pomodoro_phase below.
ALTER TABLE pomo_active_session ADD COLUMN IF NOT EXISTS phase_started_at BIGINT;
ALTER TABLE pomo_active_session ADD COLUMN IF NOT EXISTS credited_through BIGINT;

-- Supports the month-range queries schedule.js / progress.js run on every page load
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_date ON schedule_tasks(date);
CREATE INDEX IF NOT EXISTS idx_task_progress_email_date ON task_progress(email, date);
CREATE INDEX IF NOT EXISTS idx_pomodoro_stats_week_minutes ON pomodoro_stats(week_start, total_minutes DESC);

-- The Netlify Functions connect with the service_role key. Hosted Supabase
-- projects usually grant this by default for tables created via the SQL
-- editor, but it's not guaranteed (and isn't set up on `supabase start`'s
-- local Postgres image) — so grant explicitly rather than relying on it.
GRANT SELECT, INSERT, UPDATE, DELETE ON students, schedule_days, schedule_tasks, task_progress, pomodoro_stats, pomo_daily_sessions, pomo_active_session TO service_role;

-- Atomic increments for pomodoro_stats and pomo_daily_sessions. A plain
-- read-then-write from the Netlify Function (fetch the current total,
-- add to it, upsert) is vulnerable to a lost-update race if two requests
-- land close together — confirmed in practice: a student with two tabs
-- open, both completing the same session around the same real moment,
-- ended up with the daily session count credited twice from one genuine
-- completion. Pushing the increment into a single UPSERT statement
-- instead lets Postgres serialize it correctly via row-level locking
-- during the UPDATE, no matter how many concurrent calls arrive —
-- there's no separate "read" step for another request to race against.
CREATE OR REPLACE FUNCTION increment_pomodoro_stats(p_email TEXT, p_week_start DATE, p_minutes INTEGER)
RETURNS TABLE(total_minutes INTEGER, total_sessions INTEGER) AS $$
  INSERT INTO pomodoro_stats (email, week_start, total_minutes, total_sessions, updated_at)
  VALUES (p_email, p_week_start, p_minutes, 1, now())
  ON CONFLICT (email, week_start)
  DO UPDATE SET
    total_minutes = pomodoro_stats.total_minutes + p_minutes,
    total_sessions = pomodoro_stats.total_sessions + 1,
    updated_at = now()
  RETURNING total_minutes, total_sessions;
$$ LANGUAGE sql;

-- Deliberately does NOT drop the old 2-arg increment_pomo_daily_sessions
-- signature here — Postgres treats different parameter counts as separate
-- function identities (overloading), so this migration can run safely at
-- any time relative to the deploy that switches pomodoro-complete.js over
-- to calling the 3-arg version below. Whichever code is live at the
-- moment (old 2-arg caller or new 3-arg caller) keeps working throughout,
-- with zero window where a real student's completion would suddenly start
-- failing because the function it calls no longer exists. The old 2-arg
-- version is harmless leftover cruft once the new code is confirmed
-- deployed — safe to drop later in a separate cleanup, not urgent.
CREATE OR REPLACE FUNCTION increment_pomo_daily_sessions(p_email TEXT, p_date DATE, p_minutes INTEGER)
RETURNS TABLE(sessions_completed INTEGER, total_minutes INTEGER) AS $$
  INSERT INTO pomo_daily_sessions (email, date, sessions_completed, total_minutes, updated_at)
  VALUES (p_email, p_date, 1, p_minutes, now())
  ON CONFLICT (email, date)
  DO UPDATE SET
    sessions_completed = pomo_daily_sessions.sessions_completed + 1,
    total_minutes = pomo_daily_sessions.total_minutes + p_minutes,
    updated_at = now()
  RETURNING sessions_completed, total_minutes;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION increment_pomodoro_stats TO service_role;
GRANT EXECUTE ON FUNCTION increment_pomo_daily_sessions TO service_role;

-- Atomic "claim credit for this phase, once" check used by
-- pomodoro-complete.js — see phase_started_at/credited_through above. The
-- WHERE clause only lets the UPDATE (and thus the RETURNING row) go through
-- the first time a given phase_end_at is claimed for this student; a
-- second completion call for the same phase (two tabs mirroring one real
-- session, a retried request) matches nothing and gets no row back, so the
-- caller knows not to credit it again. Single UPDATE statement, so Postgres
-- serializes concurrent calls via row-level locking the same way
-- increment_pomodoro_stats does above — no separate read step for a second
-- request to race against.
-- phase_end_at = p_phase_end_at in the WHERE isn't redundant with the
-- caller's own pre-check (see pomodoro-complete.js) — it's what stops a
-- request from claiming an arbitrary phaseEndAt that was never actually the
-- row's current one, since without it this would happily set
-- credited_through to any value the caller passes in.
CREATE OR REPLACE FUNCTION credit_pomodoro_phase(p_email TEXT, p_phase_end_at BIGINT)
RETURNS TABLE(phase_started_at BIGINT, total_seconds INTEGER) AS $$
  UPDATE pomo_active_session
  SET credited_through = p_phase_end_at
  WHERE email = p_email
    AND phase_end_at = p_phase_end_at
    AND phase_started_at IS NOT NULL
    AND (credited_through IS NULL OR credited_through <> p_phase_end_at)
  RETURNING pomo_active_session.phase_started_at, pomo_active_session.total_seconds;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION credit_pomodoro_phase TO service_role;

-- Aggregate, batch-wide "when does everyone actually study" histogram —
-- one row per hour-of-day (0-23, IST), incremented every time a work-phase
-- session is credited (see pomodoro-complete.js, which attributes the
-- whole session to the hour it STARTED in, via phase_started_at). Powers
-- a single 24-bar chart on the checklist page's Today card. Deliberately
-- NOT per-student or per-date — this is one shared, ever-growing-in-place
-- table of exactly 24 rows, not a new row per student per day, so it
-- never needs cleanup and stays tiny regardless of how many students or
-- days accumulate into it. Starts completely empty and fills in going
-- forward from whenever this ships — no prior table ever recorded a
-- session's time-of-day (only its date), so there's nothing to backfill.
CREATE TABLE IF NOT EXISTS pomo_hourly_activity (
  hour           INTEGER PRIMARY KEY CHECK (hour >= 0 AND hour <= 23),
  session_count  INTEGER NOT NULL DEFAULT 0,
  total_minutes  INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON pomo_hourly_activity TO service_role;

-- Same atomic-UPSERT pattern as increment_pomodoro_stats/
-- increment_pomo_daily_sessions above — one row per hour, incremented
-- under row-level locking during the UPDATE rather than a racy
-- read-then-write from the Netlify Function.
CREATE OR REPLACE FUNCTION increment_hourly_activity(p_hour INTEGER, p_minutes INTEGER)
RETURNS TABLE(session_count INTEGER, total_minutes INTEGER) AS $$
  INSERT INTO pomo_hourly_activity (hour, session_count, total_minutes, updated_at)
  VALUES (p_hour, 1, p_minutes, now())
  ON CONFLICT (hour)
  DO UPDATE SET
    session_count = pomo_hourly_activity.session_count + 1,
    total_minutes = pomo_hourly_activity.total_minutes + p_minutes,
    updated_at = now()
  RETURNING session_count, total_minutes;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION increment_hourly_activity TO service_role;

-- The single highest concurrent-live-student count ever observed —
-- powers the Today card's busy meter (progress.js's hourlyBusyMeterHtml)
-- self-calibrating "Chill to Intense" scale, replacing an earlier
-- hardcoded guess at what counts as "fully Intense". One row, always —
-- same "tiny, fixed-size, never needs cleanup" shape as
-- pomo_hourly_activity above, not a growing history of every count ever
-- seen. Updated from whichever request happens to observe a new high
-- (see update_live_count_max, called from fetchLiveCount every time
-- anyone's poll/page-load checks the live count) — this can miss a true
-- peak that happens to land between two requests, an accepted
-- imprecision given no continuous monitoring exists, not a correctness
-- bug this table is meant to solve.
CREATE TABLE IF NOT EXISTS live_count_stats (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  max_count     INTEGER NOT NULL DEFAULT 0,
  max_seen_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT live_count_stats_single_row CHECK (id = 1)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON live_count_stats TO service_role;

-- Atomic "record a new high if this one actually is one" — GREATEST()
-- inside the UPDATE means concurrent requests observing different counts
-- around the same moment can't race each other into recording a lower
-- value over a higher one (the same row-level-locking-during-UPDATE
-- reasoning as increment_pomodoro_stats/increment_hourly_activity
-- above), and max_seen_at only moves when a genuine new high lands, not
-- on every call.
CREATE OR REPLACE FUNCTION update_live_count_max(p_count INTEGER)
RETURNS TABLE(max_count INTEGER) AS $$
  INSERT INTO live_count_stats (id, max_count, max_seen_at, updated_at)
  VALUES (1, p_count, now(), now())
  ON CONFLICT (id) DO UPDATE SET
    max_count = GREATEST(live_count_stats.max_count, p_count),
    max_seen_at = CASE WHEN p_count > live_count_stats.max_count THEN now() ELSE live_count_stats.max_seen_at END,
    updated_at = now()
  RETURNING max_count;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION update_live_count_max TO service_role;

-- A one-time flag, nothing more — see hourly-activity-mock-cutover.js.
-- pomo_hourly_activity was seeded with realistic-looking mock data for
-- launch (so the Today card's chart wasn't empty on day one) — direct
-- instruction: "use the mock data till 7pm tomorrow and then update it
-- to the real data calculated in between till forever." A scheduled
-- function checks this row every 15 minutes and, once past the deadline,
-- subtracts the exact known mock baseline back out of every hour bucket
-- (leaving only whatever real sessions contributed since launch), then
-- sets `done` here so it can never run that subtraction a second time.
CREATE TABLE IF NOT EXISTS hourly_activity_cutover (
  id      INTEGER PRIMARY KEY DEFAULT 1,
  done    BOOLEAN NOT NULL DEFAULT false,
  done_at TIMESTAMPTZ,
  CONSTRAINT hourly_activity_cutover_single_row CHECK (id = 1)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON hourly_activity_cutover TO service_role;

-- Atomic claim-once, same reasoning as credit_pomodoro_phase above — this
-- runs on a 15-minute cron, so two invocations CAN overlap in flight
-- (a slow one still running when the next one starts). The WHERE
-- done = false on the UPDATE branch means a second, racing caller's
-- UPDATE matches zero rows once the first has already flipped it to
-- true, so it gets nothing back from RETURNING and knows to skip the
-- subtraction rather than doing it twice.
CREATE OR REPLACE FUNCTION claim_hourly_activity_cutover()
RETURNS TABLE(claimed BOOLEAN) AS $$
  INSERT INTO hourly_activity_cutover (id, done, done_at)
  VALUES (1, true, now())
  ON CONFLICT (id) DO UPDATE SET
    done = true,
    done_at = now()
  WHERE hourly_activity_cutover.done = false
  RETURNING true AS claimed;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION claim_hourly_activity_cutover TO service_role;

-- Discord announcements the /team page can create/edit — any webhook
-- (any channel), fully custom text or one of a few built-in dynamic
-- sources (today's top student, last week's top 5, monthly consistency —
-- see discord-dispatch.js), any date/time/recurrence. Netlify Scheduled
-- Functions run on a cron baked in at deploy time, so a user-editable
-- schedule can't map to "one cron per post" — instead discord-dispatch.js
-- runs on one fixed, frequent cron and queries this table for whatever's
-- actually due right now, per row, via next_fire_at.
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT NOT NULL DEFAULT 'custom', -- 'custom' | 'daily_leader' | 'weekly_leaderboard' | 'monthly_consistency'
  webhook_url           TEXT NOT NULL,
  title                 TEXT, -- built-in sources fall back to their hardcoded default title if blank
  body                  TEXT, -- 'custom': the literal message. Built-in sources: a {{name}}/{{hours}}-style template
  tag_everyone          BOOLEAN NOT NULL DEFAULT false,
  color                 INTEGER,
  schedule_type         TEXT NOT NULL,     -- 'once' | 'daily' | 'weekly' | 'monthly'
  schedule_time         TEXT NOT NULL,     -- 'HH:MM', IST
  schedule_date         DATE,              -- for 'once'
  schedule_day_of_week  INTEGER,           -- 0-6 (Sun-Sat), for 'weekly'
  schedule_day_of_month INTEGER,           -- 1-31, for 'monthly' (clamped to the real last day in short months)
  next_fire_at          TIMESTAMPTZ,       -- computed on save and after every firing — what the dispatcher queries on
  last_fired_at         TIMESTAMPTZ,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts(next_fire_at) WHERE enabled;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_posts TO service_role;

-- A human-readable label for which real Discord channel a row's
-- webhook_url actually points at (e.g. "#announcements") — purely for
-- /team's own display, no functional effect on where the post actually
-- goes (that's still webhook_url). Without this, telling rows apart in
-- the list means decoding opaque webhook URLs by eye.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS channel_name TEXT;

-- Free text for any mention beyond the tag_everyone checkbox — @here, a
-- role ping (<@&ROLE_ID>), a specific user (<@USER_ID>). Combined with
-- '@everyone' (if tag_everyone is also checked) into one content string
-- when the post actually fires — see discord-dispatch.js.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS extra_mentions TEXT;

-- Remembered per-row purely as a UI convenience for /team's "Send Test"
-- button (team-posts.js's POST ?test=1) — never read by discord-dispatch.js,
-- which only ever posts a real firing to webhook_url. Saves having to
-- retype your test channel's webhook every time you reopen this post to
-- test a wording change.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS test_webhook_url TEXT;

-- Free-text notes an admin can attach to a student from /team's Students
-- view (e.g. "reached out about scholarship", "flag for testimonial") —
-- purely for the team's own reference, no effect on any tracker behavior.
ALTER TABLE students ADD COLUMN IF NOT EXISTS notes TEXT;

-- Optional array of {title, body, color} for a 'custom' post that needs
-- more than one embed in a single message (e.g. a weekly schedule post:
-- one header card + a full-width card per subject) — see
-- resolveScheduledPostEmbed() in lib/supabase.js. NULL/empty for an
-- ordinary single-embed custom post, unused by every other source.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS sections JSONB;

-- Telegram support, added ahead of an actual bot existing — built so a
-- row is "fully functional" the moment a real bot token + chat id are
-- typed into /team, no further engineering needed. A row's platform
-- decides how discord-dispatch.js posts it (still one shared dispatcher,
-- not a second cron — see that file's own comment on why); every other
-- column (source, title, body, sections, schedule_*) means exactly the
-- same thing regardless of platform, since resolveScheduledPostText()
-- reuses the exact same data-fetchers as the Discord embed path.
--
-- webhook_url/test_webhook_url are reused for Telegram rows too, holding
-- the bot's API base with its token embedded
-- (https://api.telegram.org/bot<TOKEN>) rather than a Discord webhook —
-- same "the endpoint/credential to POST to" role either way, so no new
-- column was needed for the credential itself. Telegram still needs a
-- destination *within* that bot's reach, which a URL alone doesn't
-- encode (unlike a Discord webhook, which is already channel-specific) —
-- that's what these two new columns are for.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'discord';
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS telegram_test_chat_id TEXT;

-- Cached final rank for a closed week, added 2026-09-06 as part of a cost
-- reduction pass — pomodoro-leaderboard.js's rank-movement-arrow feature
-- used to re-fetch EVERY active student's entire previous week on every
-- 30-second poll, all week, just to recompute a ranking that can never
-- change once that week is over. NULL for the current, still-open week
-- (nothing to rank yet) and for any week not yet processed by
-- weekly-rank-snapshot.js; populated once, permanently, the first time
-- that scheduled function runs after the week closes.
ALTER TABLE pomodoro_stats ADD COLUMN IF NOT EXISTS final_rank INTEGER;

-- Bulk-ranks one closed week in a single statement (a window function,
-- not a per-row loop from the calling function) — matches this schema's
-- existing precedent of pushing set-based work into a Postgres function
-- rather than doing it row-by-row from JS (see increment_pomodoro_stats
-- above). Safe to call repeatedly for the same week; it just recomputes
-- and overwrites the same ranks each time (idempotent).
--
-- ROW_NUMBER(), not RANK() — a real bug, caught by comparing this
-- function's output against the old live-computed ranking before
-- switching pomodoro-leaderboard.js's read path over: the previous
-- behavior (a plain JS array index over `.order('total_minutes', {
-- ascending: false })`) assigns strictly sequential 1,2,3,4... with no
-- tie-awareness — students tied at the same total_minutes just got
-- whatever consecutive numbers Postgres happened to return them in.
-- RANK() instead gives every tied student the SAME rank and skips the
-- following numbers (competition-style: two people tied for 47th both
-- get 47, the next distinct value jumps to 51) — arguably more "correct"
-- for a real ranking, but a genuine behavior change from what's shipping
-- today, confirmed directly: four students tied at 120 minutes diverged
-- from the old output by exactly that skip. ROW_NUMBER() reproduces the
-- old sequential-numbering behavior instead.
CREATE OR REPLACE FUNCTION compute_weekly_final_ranks(p_week_start DATE)
RETURNS void AS $$
  UPDATE pomodoro_stats
  SET final_rank = ranked.rnk
  FROM (
    SELECT email, ROW_NUMBER() OVER (ORDER BY total_minutes DESC) AS rnk
    FROM pomodoro_stats
    WHERE week_start = p_week_start
  ) ranked
  WHERE pomodoro_stats.email = ranked.email AND pomodoro_stats.week_start = p_week_start;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION compute_weekly_final_ranks TO service_role;

-- Cached streak, added 2026-09-06, second step of the same cost-reduction
-- pass — computeStreak() (lib/supabase.js) used to be redone from full
-- history independently by THREE call sites (pomodoro-leaderboard.js on
-- every 30s poll, streak.js on every task toggle, team-students.js for
-- all 302 students on every admin page load), each re-fetching every
-- completed task ever for the students it cares about. Updated two
-- different ways, not one, since a streak can change without any write
-- happening: complete-task.js recomputes the ONE student's streak the
-- moment they actually tick something (same-day accuracy — a checkbox
-- click should reflect immediately, not tomorrow); daily-streak-
-- snapshot.js recomputes EVERYONE once a day (catches a streak breaking
-- purely from a day passing with no action — no write event exists to
-- hook for that case at all). Default 0, not null, since "no streak yet"
-- and "streak of zero" are the same displayable thing here, unlike
-- final_rank above (where null specifically means "not computed yet,"
-- distinct from a real rank).
ALTER TABLE students ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0;

-- Bulk-updates current_streak for many students in one statement, given
-- two parallel arrays (unnest() zips them back into rows). NOT a plain
-- supabase-js .upsert([{email, current_streak}, ...]) — tried that first
-- and it failed outright: Postgres validates an INSERT ... ON CONFLICT's
-- *proposed insert row* against NOT NULL constraints (students.display_name
-- has one, with no default) before it even evaluates whether a conflict
-- exists, so a partial-column upsert fails hard even when every row
-- already exists and should only ever hit the UPDATE branch. A real
-- UPDATE has no such problem — it only touches the columns actually
-- listed in SET, never constructs a full candidate row, so it can't trip
-- a NOT NULL constraint on a column it isn't touching. Confirmed this
-- exact failure mode directly, on a disposable test student, before it
-- could reach any real one.
CREATE OR REPLACE FUNCTION update_student_streaks(p_emails TEXT[], p_streaks INTEGER[])
RETURNS void AS $$
  UPDATE students
  SET current_streak = v.streak
  FROM (SELECT unnest(p_emails) AS email, unnest(p_streaks) AS streak) v
  WHERE students.email = v.email;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION update_student_streaks TO service_role;

-- All-time focus minutes, cached on the student row rather than summed
-- live — powers a "hover a name, see their all-time total" tooltip on
-- the leaderboards (direct request: "whenever someone hovers over
-- someone's name can we show them their total minutes... is it too much
-- resource intensive"). The boards already show that WEEK's or that
-- DAY's total right next to each name; this is the genuinely new number
-- (their whole-program total), and the whole point of caching it here —
-- same reasoning as current_streak above — is that showing it costs
-- nothing extra per hover: it's fetched once per leaderboard poll/page
-- load (fetchAllTimeMinutesByEmail in lib/supabase.js, its own query,
-- kept separate from the main students SELECT so a pre-migration
-- "column does not exist" error there can never break display_name/
-- streak rendering), not a live SUM(pomodoro_stats.total_minutes)
-- aggregate query or a network call per hover.
ALTER TABLE students ADD COLUMN IF NOT EXISTS all_time_minutes INTEGER NOT NULL DEFAULT 0;

-- One-time backfill so "all-time" is actually correct from the moment
-- this ships, not just counting forward from zero for students who
-- already have months of real history in pomodoro_stats.
UPDATE students s
SET all_time_minutes = COALESCE((
  SELECT SUM(ps.total_minutes) FROM pomodoro_stats ps WHERE ps.email = s.email
), 0);

-- Same atomic-UPDATE-under-row-level-locking pattern as
-- increment_pomodoro_stats/increment_pomo_daily_sessions above — called
-- from pomodoro-complete.js alongside those two, right when a session is
-- actually credited. A plain UPDATE, not an upsert: a session can only
-- ever be credited to a student who already has a row (every other write
-- in that same function already assumes this), so there's no ON CONFLICT
-- branch to worry about the way current_streak's bulk updater does.
CREATE OR REPLACE FUNCTION increment_student_all_time_minutes(p_email TEXT, p_minutes INTEGER)
RETURNS TABLE(all_time_minutes INTEGER) AS $$
  UPDATE students
  SET all_time_minutes = students.all_time_minutes + p_minutes
  WHERE email = p_email
  RETURNING students.all_time_minutes;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION increment_student_all_time_minutes TO service_role;

-- A record of every real completion attempt pomodoro-complete.js rejects
-- (or errors on), added after a real, unresolved report (2026-09-21): a
-- student's genuinely-completed 2-hour Focus session never showed up in
-- pomo_daily_sessions, and the investigation had nothing to go on — the
-- 400/500 responses this endpoint returns leave no trace anywhere once
-- the response is sent, so there was no way to tell WHICH check failed or
-- why, only that it had. This table exists so the next occurrence leaves
-- an actual record instead of another after-the-fact guessing session.
-- session_snapshot holds whatever pomo_active_session looked like at
-- rejection time (null if no row existed at all for that email).
CREATE TABLE IF NOT EXISTS pomodoro_credit_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  claimed_phase_end_at BIGINT,
  session_snapshot JSONB,
  elapsed_ms BIGINT,
  claimed_ms BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pomodoro_credit_failures_email ON pomodoro_credit_failures(email, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON pomodoro_credit_failures TO service_role;

-- Explicit, admin-controlled tiebreak for two scheduled_posts rows that
-- share the exact same next_fire_at (e.g. weekly_leaderboard and
-- weekly_batch_trend, both set to fire at 10:30 IST) — discord-dispatch.js
-- orders by this (then created_at) so which one posts first is a
-- deliberate choice made via /team's ▲/▼ buttons, not whatever order an
-- otherwise-unordered query happens to return. Default 0 for every row
-- that's never been manually reordered, so created_at (the row created
-- first posts first) is what actually decides ties until someone
-- explicitly reorders them.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS dispatch_order INTEGER NOT NULL DEFAULT 0;

-- Malpractice detection for the Pomodoro timer's anti-cheat check (see
-- pomodoro-complete.js's insufficient_elapsed rejection — verified live,
-- confirmed against a real student who repeatedly tried to fake session
-- completions via a manipulated browser clock). Three columns, all on
-- students: malpractice_incident_count is a distinct-attempt counter
-- (deduped by phase — a single doomed request retried 3x by the client
-- only ever counts once, see pomodoro-complete.js's dedupe check before
-- calling record_malpractice_incident below), malpractice_offense_count
-- tracks how many times a freeze has actually been triggered (used only
-- to look up the escalating duration), and malpractice_frozen_until is
-- the live freeze deadline itself, checked by pomo-active.js before
-- allowing a new work phase to start. Deliberately keyed off
-- insufficient_elapsed alone, not any other pomodoro_credit_failures
-- reason — every other reason has a known legitimate cause (e.g.
-- phase_end_mismatch from two genuine requests racing each other), where
-- insufficient_elapsed requires claiming far more real time passed than
-- actually did, well past the endpoint's own 15s grace window — not
-- something normal usage or network flakiness can trigger by accident.
ALTER TABLE students ADD COLUMN IF NOT EXISTS malpractice_incident_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS malpractice_offense_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS malpractice_frozen_until TIMESTAMPTZ;
-- How many times the CURRENT warning tier (2-3 incidents, no freeze) has
-- been shown-and-dismissed via the Okay button — see
-- increment_malpractice_warning_ack below and its own comment. Reset to
-- 0 by record_malpractice_incident every time a genuinely new incident
-- happens, so a fresh incident always gets its own fresh 3-nag budget
-- rather than inheriting an already-exhausted one from an earlier tier.
ALTER TABLE students ADD COLUMN IF NOT EXISTS malpractice_warning_ack_count INTEGER NOT NULL DEFAULT 0;

-- Atomic claim-and-escalate, called once per genuinely NEW distinct
-- incident (never per retry — see the dedupe check at pomodoro-
-- complete.js's call site). The first 3 distinct incidents are silent-log/
-- warning-only (progress.js decides what to show based on the returned
-- malpractice_incident_count, 1 = nothing shown, 2-3 = a warning banner) —
-- only the 4th and every one after that actually escalates
-- malpractice_offense_count and (re)sets a fresh freeze, looked up from a
-- fixed escalation ladder: 6h -> 24h -> 72h -> 7 days, capped at the last
-- tier for anything beyond. A plain `now() + tier`, not stacking onto
-- whatever time was left on a previous freeze — a genuinely NEW incident
-- can only happen after a previous freeze has already expired in the
-- first place, since pomo-active.js refuses to start a new work phase at
-- all while already frozen, so there's no "still-frozen-plus-new-offense"
-- case to reconcile. Also resets malpractice_warning_ack_count to 0 on
-- every call — a genuinely new incident means the warning is worth
-- showing again from scratch, not counted against whatever nagging
-- budget an earlier, different incident already used up.
CREATE OR REPLACE FUNCTION record_malpractice_incident(p_email TEXT)
RETURNS TABLE(malpractice_incident_count INTEGER, malpractice_offense_count INTEGER, malpractice_frozen_until TIMESTAMPTZ) AS $$
  UPDATE students
  SET
    malpractice_incident_count = students.malpractice_incident_count + 1,
    malpractice_offense_count = CASE
      WHEN students.malpractice_incident_count + 1 >= 4 THEN students.malpractice_offense_count + 1
      ELSE students.malpractice_offense_count
    END,
    malpractice_frozen_until = CASE
      WHEN students.malpractice_incident_count + 1 >= 4 THEN
        now() + (CASE LEAST(students.malpractice_offense_count + 1, 4)
          WHEN 1 THEN INTERVAL '6 hours'
          WHEN 2 THEN INTERVAL '24 hours'
          WHEN 3 THEN INTERVAL '72 hours'
          ELSE INTERVAL '7 days'
        END)
      ELSE students.malpractice_frozen_until
    END,
    malpractice_warning_ack_count = 0
  WHERE email = p_email
  RETURNING students.malpractice_incident_count, students.malpractice_offense_count, students.malpractice_frozen_until;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION record_malpractice_incident TO service_role;

-- Called once per Okay click on the (non-freeze) warning gate — see
-- malpractice-ack.js and the client-side gating in
-- renderPomoMalpracticeGateHtml/progress.js: the gate only shows while
-- malpractice_warning_ack_count < 3, so a specific incident tier nags at
-- most 3 times (across however many separate Focus Mode visits that
-- spans) before going quiet on its own, without needing the underlying
-- incident_count itself to ever decrease — that count stays a permanent,
-- honest record for admin visibility, only the VISIBLE nagging stops.
-- Capped at 3 server-side too (not just relying on the client to stop
-- asking), since a determined client could otherwise increment this
-- indefinitely for no real benefit — LEAST just makes that a harmless
-- no-op past 3 rather than actually preventing it.
CREATE OR REPLACE FUNCTION increment_malpractice_warning_ack(p_email TEXT)
RETURNS TABLE(malpractice_warning_ack_count INTEGER) AS $$
  UPDATE students
  SET malpractice_warning_ack_count = LEAST(students.malpractice_warning_ack_count + 1, 3)
  WHERE email = p_email
  RETURNING students.malpractice_warning_ack_count;
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION increment_malpractice_warning_ack TO service_role;
