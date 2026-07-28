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
  updated_at         TIMESTAMP DEFAULT now(),
  PRIMARY KEY (email, date)
);

-- Supports the month-range queries schedule.js / progress.js run on every page load
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_date ON schedule_tasks(date);
CREATE INDEX IF NOT EXISTS idx_task_progress_email_date ON task_progress(email, date);
CREATE INDEX IF NOT EXISTS idx_pomodoro_stats_week_minutes ON pomodoro_stats(week_start, total_minutes DESC);

-- The Netlify Functions connect with the service_role key. Hosted Supabase
-- projects usually grant this by default for tables created via the SQL
-- editor, but it's not guaranteed (and isn't set up on `supabase start`'s
-- local Postgres image) — so grant explicitly rather than relying on it.
GRANT SELECT, INSERT, UPDATE, DELETE ON students, schedule_days, schedule_tasks, task_progress, pomodoro_stats, pomo_daily_sessions TO service_role;
