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
