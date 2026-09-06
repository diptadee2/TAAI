// GET /api/streak?email=...
// Consecutive-day streak. Reads the cached students.current_streak column
// instead of recomputing from schedule_tasks + task_progress on every call
// — kept correct by complete-task.js's same-day write (awaited before that
// endpoint responds, so a refreshStreak() call right after a task toggle in
// progress.js always sees the fresh value) and daily-streak-snapshot.js's
// daily sweep for streaks that should break from a day passing with no
// action. See CLAUDE.md's streak-caching write-up for the full design and
// computeStreak() in lib/supabase.js for the semantics this cache mirrors.
import { getSupabase, json } from './lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const email = String(event.queryStringParameters?.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });

  const supabase = getSupabase();

  const { data: student, error } = await supabase
    .from('students')
    .select('current_streak')
    .eq('email', email)
    .maybeSingle();
  if (error) return json(500, { error: error.message });

  return json(200, { streak: student ? student.current_streak || 0 : 0 });
}
