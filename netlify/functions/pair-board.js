// POST /api/pair-board  — a private, passcode-protected shared checklist for a
// pair of people studying the same roadmap together (added 2026-10-23, used by
// /sunitesh101). Each person ticks a task for themselves; a task counts as done
// for the pair once either has ticked it, and the page shows both names.
//
// Nothing private lives in this file or the page, because the repo is public:
// the roadmap text and a SHA-256 hash of the passcode are stored only in the
// pair_boards row (loaded by scripts/seed-pair-board.mjs from a gitignored
// file). Every action, including reading the roadmap, needs the passcode,
// unless the board has none: an empty passcode_hash means an open board
// (/sunitesh101 since 2026-10-23, at the user's request; it stays noindex).
//
// Body: { board, code, action, ... }
//   action 'load'                      -> { title, notes, sections, names, ticks }
//   action 'tick'   { taskId, by, done } -> { ok, ticks }  (by: 0 or 1; that person's own tick)
//   action 'names'  { names: [a, b] }  -> { ok, names }
//   action 'note-add'    { taskId, by, url, label } -> { ok, note }
//   action 'note-remove' { id }                     -> { ok }   (either person can remove any link)
import crypto from 'node:crypto';
import { getSupabase, json } from './lib/supabase.js';

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
const reply = (status, body) => {
  const r = json(status, body);
  r.headers = Object.assign({}, r.headers, NO_STORE);
  return r;
};

export function passcodeHash(board, code) {
  return crypto.createHash('sha256').update(String(board) + ':' + String(code)).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex'), y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 24);

export async function handler(event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'invalid JSON' }); }
  const board = String(body.board || '').slice(0, 60);
  const code = String(body.code || '').slice(0, 100);
  if (!board) return reply(401, { error: 'locked' });

  const supabase = getSupabase();
  const { data: row, error } = await supabase.from('pair_boards').select('*').eq('slug', board).maybeSingle();
  // A missing board and a wrong passcode look the same from outside, and both
  // wait a moment so guessing is slow.
  const open = !!row && !row.passcode_hash;
  if (error || !row || (!open && !sameHash(passcodeHash(board, code), row.passcode_hash))) {
    await new Promise(r => setTimeout(r, 600));
    return reply(401, { error: 'locked' });
  }

  const taskIds = new Set();
  for (const s of row.roadmap.sections || []) for (const t of s.tasks || []) {
    taskIds.add(t.id);
    if (t.revision) taskIds.add(t.revision.id); // the day's cumulative revision item, ticked separately
  }

  if (body.action === 'load') {
    const [{ data: ticks, error: tErr }, notesRes] = await Promise.all([
      supabase.from('pair_ticks').select('task_id, done_by, done_at').eq('board', board),
      supabase.from('pair_notes').select('id, task_id, added_by, url, label, created_at').eq('board', board).order('created_at'),
    ]);
    if (tErr) return reply(500, { error: tErr.message });
    // links: [] (not an error) until the pair_notes table exists.
    return reply(200, { open, title: row.roadmap.title, notes: row.roadmap.notes || [], sections: row.roadmap.sections, names: row.names, ticks: ticks || [],
      links: notesRes.error ? [] : (notesRes.data || []), linksReady: !notesRes.error });
  }

  if (body.action === 'tick') {
    // Each person has their own tick on a task (2026-10-23: "it should show both
    // the names when clicked by both"). done:true adds the caller's tick (a repeat
    // is a no-op), done:false removes only the caller's. Returns every tick on the
    // task so the page shows both names.
    const taskId = String(body.taskId || '');
    if (!taskIds.has(taskId)) return reply(400, { error: 'unknown task' });
    const by = body.by === 1 ? 1 : 0;
    if (body.done) {
      const tick = { board, task_id: taskId, done_by: by, done_at: new Date().toISOString() };
      const { error: e } = await supabase.from('pair_ticks').upsert(tick, { onConflict: 'board,task_id,done_by', ignoreDuplicates: true });
      if (e) return reply(500, { error: e.message });
    } else {
      const { error: e } = await supabase.from('pair_ticks').delete().eq('board', board).eq('task_id', taskId).eq('done_by', by);
      if (e) return reply(500, { error: e.message });
    }
    const { data: ticks, error: tErr } = await supabase.from('pair_ticks').select('task_id, done_by, done_at').eq('board', board).eq('task_id', taskId);
    if (tErr) return reply(500, { error: tErr.message });
    return reply(200, { ok: true, ticks: ticks || [] });
  }

  if (body.action === 'names') {
    const names = Array.isArray(body.names) ? body.names.map(cleanName) : [];
    if (names.length !== 2 || !names[0] || !names[1]) return reply(400, { error: 'two names needed' });
    const { error: e } = await supabase.from('pair_boards').update({ names, updated_at: new Date().toISOString() }).eq('slug', board);
    if (e) return reply(500, { error: e.message });
    return reply(200, { ok: true, names });
  }

  // Notes links (2026-10-23): each person attaches links (usually Google Drive) to
  // a day's topic, to study later. Any https link is accepted.
  if (body.action === 'note-add') {
    const taskId = String(body.taskId || '');
    if (!taskIds.has(taskId)) return reply(400, { error: 'unknown task' });
    const url = String(body.url || '').trim();
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === 'https:' && url.length <= 600; } catch {}
    if (!ok) return reply(400, { error: 'Paste a full link starting with https://' });
    const note = { board, task_id: taskId, added_by: body.by === 1 ? 1 : 0, url, label: String(body.label || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null };
    const { data, error: e } = await supabase.from('pair_notes').insert(note).select('id, task_id, added_by, url, label, created_at').single();
    if (e) return reply(500, { error: e.message });
    return reply(200, { ok: true, note: data });
  }

  if (body.action === 'note-remove') {
    const id = String(body.id || '');
    const { error: e } = await supabase.from('pair_notes').delete().eq('board', board).eq('id', id);
    if (e) return reply(500, { error: e.message });
    return reply(200, { ok: true });
  }

  return reply(400, { error: 'unknown action' });
}
