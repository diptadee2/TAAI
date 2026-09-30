// POST /api/migrate-batch  { email, batch }
//
// Lets an already-registered student switch which batch's schedule they
// follow — a real, destructive action, gated behind an explicit warning
// client-side (see progress.js's state.pendingBatchMigration), not
// something a stray click can trigger silently.
//
// Destructive by design: task_progress isn't batch-tagged (see
// schema.sql's own comment on that table — email->students.batch is
// meant to be sufficient disambiguation for a student who only ever
// touches their OWN batch's schedule). Once a student can genuinely
// switch batches, that assumption breaks — an old completion could
// otherwise coincidentally "match" a same date/subject/task_text on the
// new batch's schedule and silently show as already-done. Wiping the
// student's task_progress on migration removes that risk entirely, and
// is also what makes the client's "your progress will be lost" warning
// literally true rather than just a vague caution. current_streak is
// reset to 0 in the same update, rather than leaving a stale cached
// number sitting there until daily-streak-snapshot.js's next sweep
// notices the schedule underneath it changed.
//
// Everything else about the student — Pomodoro history, all_time_minutes,
// malpractice/rename-gate state, display_name — is untouched. None of
// that is about which syllabus a student follows, so none of it should
// move just because their batch did.
import { getSupabase, json } from './lib/supabase.js';

// Hand-duplicated in register.js and progress.js — same small-constant-
// across-the-client/server-boundary tradeoff already accepted elsewhere
// (e.g. POMO_WORK_MAX_MINUTES).
const VALID_BATCHES = ['C', 'D'];

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const batch = String(body.batch || '').trim();
  if (!email) return json(400, { error: 'email is required' });
  if (!VALID_BATCHES.includes(batch)) return json(400, { error: 'invalid batch' });

  const supabase = getSupabase();

  const { data: existing, error: fetchErr } = await supabase.from('students').select('email, batch').eq('email', email).maybeSingle();
  if (fetchErr) return json(500, { error: fetchErr.message });
  if (!existing) return json(404, { error: 'student not found' });

  // Already on this batch — a genuine no-op, not an error. Nothing to
  // wipe, nothing to migrate; just hand back the current record.
  if (existing.batch === batch) {
    const { data: student, error: rereadErr } = await supabase.from('students').select('email, display_name, batch').eq('email', email).maybeSingle();
    if (rereadErr) return json(500, { error: rereadErr.message });
    return json(200, student);
  }

  const { error: wipeErr } = await supabase.from('task_progress').delete().eq('email', email);
  if (wipeErr) return json(500, { error: wipeErr.message });

  const { data: updated, error: updateErr } = await supabase
    .from('students')
    .update({ batch, current_streak: 0 })
    .eq('email', email)
    .select('email, display_name, batch')
    .single();
  if (updateErr) return json(500, { error: updateErr.message });

  return json(200, updated);
}
