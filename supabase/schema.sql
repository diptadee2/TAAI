-- TAAI Progress Tracker — Supabase schema (v4 spec)
-- Run this once in the Supabase SQL editor for the project used by
-- SUPABASE_URL / SUPABASE_SERVICE_KEY. Safe to re-run (IF NOT EXISTS guards).

-- Student identity
CREATE TABLE IF NOT EXISTS students (
  email         TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT now()
);

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

-- Supports the month-range queries schedule.js / progress.js run on every page load
CREATE INDEX IF NOT EXISTS idx_schedule_tasks_date ON schedule_tasks(date);
CREATE INDEX IF NOT EXISTS idx_task_progress_email_date ON task_progress(email, date);
