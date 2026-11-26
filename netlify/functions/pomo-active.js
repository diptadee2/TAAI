// POST /api/pomo-active  { email, mode, running, secondsLeft, totalSeconds, phaseEndAt, completedSessions, deviceToken }
//
// Persists the pomodoro timer's active/paused state server-side, mirroring
// what's already written to this device's own localStorage (see
// savePomoActiveState in progress.js). Called on every meaningful client-
// side change — start, pause, skip, reset, phase-advance — the same
// choke point that already writes localStorage. This is what lets a
// student open the tracker on a different browser/device and correctly
// see an already-running session (see tracker-data.js's pomoActive field
// for the read side) instead of a fresh, unaware timer.
//
// Fire-and-forget from the client (non-critical if it fails, same as
// pomo-settings) — a lost write here just means cross-device sync is
// stale until the next successful one, not that the timer itself breaks;
// localStorage remains the authoritative same-device state regardless.
import { getSupabase, json, clockSkewMs } from './lib/supabase.js';

// Time left in a running phase, measured on the server's clock (2026-11-20):
// the remaining time the owning device last reported, minus how long ago
// (server time) it reported it. Devices count down from this instead of
// comparing the owner's phase_end_at (the owner's own clock) with theirs,
// so the countdown is right even when two devices' clocks disagree.
// Stored times come back two ways: phase_started_at is epoch milliseconds (a
// number) and updated_at is a TIMESTAMP without a time zone, written as UTC
// but returned without a "Z", which Date.parse would read as local time.
const LATE_START_CAP_MS = 3 * 60 * 1000;
function tsMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const str = String(v);
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(str) ? str : str + 'Z');
}
// Is the stored phase still running, and with how much margin? Measured on
// the server's clock (msLeftOf) when possible; the old comparison of the
// owner's phase_end_at with the requester's clock is only the fallback.
// Using the owner's clock let a device whose clock ran slow look finished
// early, so a second device could start a new session on top of it and
// both got credited (2026-11-20, real-device report).
function stillRunning(row, skewMs, marginMs) {
  if (!row || !row.running) return false;
  const left = msLeftOf(row);
  if (left != null) return left > (marginMs || 0);
  return Number.isFinite(row.phase_end_at) && row.phase_end_at > Date.now() + skewMs + (marginMs || 0);
}
function msLeftOf(row) {
  if (!row || !row.running || !Number.isFinite(row.seconds_left) || !row.updated_at) return null;
  const since = Date.now() - tsMs(row.updated_at);
  if (!Number.isFinite(since)) return null;
  return Math.max(0, row.seconds_left * 1000 - since);
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email is required' });
  if (body.mode !== 'work' && body.mode !== 'break') return json(400, { error: 'mode must be "work" or "break"' });

  const totalSeconds = Number.isFinite(body.totalSeconds) ? body.totalSeconds : null;
  const secondsLeft = Number.isFinite(body.secondsLeft) ? body.secondsLeft : null;
  const running = !!body.running;

  const supabase = getSupabase();

  // phase_started_at backs pomodoro-complete.js's server-side verification
  // that a claimed session actually ran (see credit_pomodoro_phase in
  // schema.sql) — it has to be this server's own clock, never anything the
  // client sends, so a fresh Date.now() is only stamped here when this
  // update genuinely represents a NEW phase starting: mode or duration
  // changed from what's currently stored, or running just flipped on with
  // a full, unconsumed duration (a real Start/Skip/Reset-then-Start, not a
  // Pause/Resume of the same in-progress phase, which should keep
  // accumulating from when it first began).
  const { data: existing, error: readError } = await supabase
    .from('pomo_active_session')
    // owner_token is read here too (2026-11-22): it used to be a second,
    // separate read of this same row (a safety net from before the column
    // existed), which doubled the database requests of every check and save.
    .select('mode, total_seconds, phase_started_at, running, phase_end_at, seconds_left, updated_at, owner_token')
    .eq('email', email)
    .maybeSingle();
  if (readError) return json(500, { error: readError.message });

  // Read-only look at the stored session, and "Switch to this device"
  // (2026-11-20). A device that isn't running the student's session shows
  // "running on another device" with a Switch button; switching moves
  // ownership (owner_token) to it and leaves the session itself untouched,
  // so no time is lost and it is still credited once.
  // Which kind of device owns the session (2026-11-21, "can't we know which
  // device was last used?"). Stored with the owner's id in owner_token as
  // "<id>|<kind>", so no new column; ids never contain "|", and rows from
  // before this have no kind (shown as "another device").
  const DEVICE_KINDS = ['laptop', 'iphone', 'phone', 'ipad', 'tablet'];
  const kind = DEVICE_KINDS.includes(body.deviceKind) ? body.deviceKind : null;
  const tokId = (v) => (v ? String(v).split('|')[0] : null);
  const tokKind = (v) => { const k = v ? String(v).split('|')[1] : null; return DEVICE_KINDS.includes(k) ? k : null; };
  const withKind = (t) => (t && kind ? t + '|' + kind : t);

  if (body.action === 'peek' || body.action === 'takeover') {
    const token = typeof body.deviceToken === 'string' ? body.deviceToken.slice(0, 64) : null;
    let owner = existing ? existing.owner_token || null : null;
    const view = (ownedByYou) => {
      if (!existing) return null;
      const st = tsMs(existing.phase_started_at);
      return {
        mode: existing.mode, running: !!existing.running, totalSeconds: existing.total_seconds,
        phaseEndAt: existing.phase_end_at, secondsLeft: existing.seconds_left,
        phaseAgeMs: Number.isFinite(st) ? Math.max(0, Date.now() - st) : null,
        msLeft: msLeftOf(existing),
        // How long ago the stored record last changed (an age, so device
        // clocks don't matter). Lets a device tell whether a Reset/Skip made
        // elsewhere is newer than its own last change (2026-11-22).
        updatedAgeMs: Number.isFinite(tsMs(existing.updated_at)) ? Math.max(0, Date.now() - tsMs(existing.updated_at)) : null,
        ownedByYou,
        device: tokKind(owner),
      };
    };
    const skew = clockSkewMs(body.clientNow);
    const active = stillRunning(existing, skew, 0);
    if (body.action === 'peek') return json(200, { ok: true, state: view(!owner || tokId(owner) === token) });
    if (!active || !token) return json(200, { ok: true, takenOver: false, state: view(!owner || tokId(owner) === token) });
    owner = withKind(token);
    const { error: tErr } = await supabase.from('pomo_active_session').update({ owner_token: owner }).eq('email', email);
    if (tErr) return json(500, { error: tErr.message });
    return json(200, { ok: true, takenOver: true, state: view(true) });
  }

  const isNewPhase = !existing ||
    existing.mode !== body.mode ||
    existing.total_seconds !== totalSeconds ||
    (running && secondsLeft === totalSeconds);

  // Multi-device/tab ownership protection (see owner_token in schema.sql)
  // — a real bug, confirmed against production: without this, a second,
  // stale tab/device re-syncing its own old idle state can silently
  // clobber a genuinely in-progress session on a DIFFERENT device right
  // before its completion call arrives, wiping out the only server-side
  // record pomodoro-complete.js verifies elapsed time against. (This used to
  // be its own separate query, kept apart from the `existing` select while
  // the column might not exist yet; the column has long existed, so since
  // 2026-11-22 it's read with that select instead. Originally the
  // same fault-tolerance discipline as the malpractice freeze check just
  // above.)
  const deviceToken = typeof body.deviceToken === 'string' && body.deviceToken ? body.deviceToken.slice(0, 100) : null;
  // Read with the row above (2026-11-22); no second query.
  const existingOwnerToken = existing ? existing.owner_token || null : null;

  // Only blocks a write that would actually CHANGE the phase (isNewPhase)
  // while a DIFFERENT device's session is still genuinely active (running,
  // and its own deadline hasn't passed) — a same-device update (matching
  // token, or no token recorded yet e.g. pre-migration) always proceeds
  // normally, and so does anything once the owning device's phase has
  // actually ended. The owning device keeps priority until its own
  // session naturally completes/expires/changes, rather than losing to
  // whichever device's sync happens to land last.
  // phase_end_at is a CLIENT timestamp (the device's own clock), so judge
  // "has it ended" on the requesting device's clock, not the server's.
  // Real report 2026-10-04 (Uday, uday35700@): his device ran ~1.5 min
  // fast, so his next-phase write landed while the server still thought
  // the old phase was running and was ignored; the new 2h session then
  // never existed server-side and got zero credit, four times.
  const clientSkewMs = clockSkewMs(body.clientNow);
  const existingStillActive = stillRunning(existing, clientSkewMs, 0);
  // While a phase is running and unexpired, ONLY the tab/device that started
  // it (owner_token) may change it. Widened 2026-10-01 from "new phases
  // only, and only when a token is present": a stale tab's pagehide beacon
  // (running:false, its own hours-old state, and no deviceToken at all on
  // older clients) was overwriting students' real running sessions, so
  // their completion was then rejected as phase_end_mismatch and the session
  // never counted. Seen in production right after the 2026-10-01 deploy
  // reloaded every open tab: one rejected row's server state was a paused
  // session started at 01:39, overwriting a live one ending at 14:02. A
  // tokenless write counts as "not the owner". The owner's own writes
  // (pause/skip/reset, its own beacon) are unaffected, and once the phase
  // ends or isn't running, any tab may write as before.
  if (existingStillActive && existingOwnerToken && tokId(existingOwnerToken) !== deviceToken) {
    // Send the running session back so the refused device can show it
    // instead of silently counting its own copy (2026-11-20).
    const startedMs = tsMs(existing.phase_started_at);
    return json(200, {
      ok: true, ignored: 'another device owns the active session',
      owner: {
        mode: existing.mode, running: true, totalSeconds: existing.total_seconds,
        phaseEndAt: existing.phase_end_at,
        phaseAgeMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : null,
        msLeft: msLeftOf(existing),
        device: tokKind(existingOwnerToken),
      },
    });
  }

  // Malpractice freeze enforcement (see record_malpractice_incident in
  // schema.sql) — only blocks genuinely starting a NEW work phase, never
  // Pause/Reset/a break phase (break earns no credit anyway, so freezing
  // it accomplishes nothing). This is the real backstop: progress.js
  // already checks the student's own frozen-until field (fetched at page
  // load via tracker-data.js) before ever calling this endpoint, so a
  // frozen student normally never gets this far at all — but this check
  // still has to exist here too, since the client-side one is only a
  // convenience a determined user could bypass by hitting this endpoint
  // directly. Checked only for a genuine new work-phase start (not every
  // call) both to keep this cheap and because that's the only case
  // "frozen" is actually supposed to mean anything for.
  // A break can't replace a work phase that hasn't finished (2026-10-11,
  // ganesh.deulkar1509: lost a 65-min session on Oct 9, 10 and 11). A
  // duplicated tab (same device token, so the owner check above can't tell
  // it apart) kept its own copy of the session running; when the real tab
  // paused and resumed, the copy reached the ORIGINAL end first and wrote
  // its break over the still-unfinished work phase, so the real tab's
  // claim failed (wrong_mode), or its resume was treated as a new phase
  // and re-dated (client_skipped). Skip is disabled during Focus and a
  // natural break only starts once work time is up, so a break write
  // against unfinished work is never legitimate, from any tab.
  if (existing && existing.mode === 'work' && body.mode === 'break') {
    const workRunningUnfinished = stillRunning(existing, clientSkewMs, 5000);
    const workPausedMidway = !existing.running && Number.isFinite(existing.seconds_left) && Number.isFinite(existing.total_seconds)
      && existing.seconds_left > 0 && existing.seconds_left < existing.total_seconds;
    if (workRunningUnfinished || workPausedMidway) {
      return json(200, { ok: true, ignored: 'work phase still in progress' });
    }
  }

  if (isNewPhase && body.mode === 'work' && running) {
    // Best-effort, not a hard dependency — pre-migration (or any other
    // failure), a broken freeze CHECK must never break the routine
    // Start/Pause/Skip/Reset sync every student relies on. A genuine
    // "column does not exist" error here would otherwise 500 this whole
    // endpoint for every single Start click until the migration runs —
    // the same class of mistake already caught once this session for the
    // all-time-minutes feature (see CLAUDE.md).
    try {
      const { data: student, error: studentError } = await supabase
        .from('students')
        .select('malpractice_frozen_until')
        .eq('email', email)
        .maybeSingle();
      if (!studentError && student?.malpractice_frozen_until && new Date(student.malpractice_frozen_until).getTime() > Date.now()) {
        return json(403, { error: 'malpractice_frozen', frozenUntil: student.malpractice_frozen_until });
      }
    } catch (e) {
      console.error('pomo-active.js: malpractice freeze check failed for', email, e);
    }

    // needs_rename enforcement (see its own comment in schema.sql) — same
    // real backstop reasoning and fault-tolerance discipline as the
    // malpractice freeze check just above: progress.js already checks
    // this client-side (state.needsRename, fetched at page load) before
    // ever calling this endpoint, but a determined user hitting this
    // directly still has to be stopped here too. Own separate try/catch,
    // not folded into the malpractice query above, so a pre-migration
    // "column does not exist" error on either one can never take down
    // the other, or this routine sync as a whole.
    try {
      const { data: renameRow, error: renameError } = await supabase
        .from('students')
        .select('needs_rename')
        .eq('email', email)
        .maybeSingle();
      if (!renameError && renameRow?.needs_rename) {
        return json(403, { error: 'needs_rename' });
      }
    } catch (e) {
      console.error('pomo-active.js: needs_rename check failed for', email, e);
    }
  }

  // A new running phase is normally dated "now". But the write that tells us
  // about it can arrive late: this device holds it while the previous
  // session's credit claim is still going through, or the network retries.
  // Then "now" is later than the real start, the finished session looks short
  // and is never credited (Mohan Keshav, 2026-11-26: a 60-minute session
  // dated 57s late, skipped). So date it back by the time the device says it
  // has already run (totalSeconds - secondsLeft), at most LATE_START_CAP_MS,
  // and never before the previous running phase's own end (no overlap).
  let phaseStartedAt = isNewPhase ? Date.now() : (existing.phase_started_at ?? Date.now());
  if (isNewPhase && running && secondsLeft < totalSeconds) {
    const ranMs = Math.min(LATE_START_CAP_MS, (totalSeconds - secondsLeft) * 1000);
    let start = Date.now() - ranMs;
    if (existing && existing.running) {
      const prevEnd = tsMs(existing.updated_at) + (Number.isFinite(existing.seconds_left) ? existing.seconds_left * 1000 : 0);
      if (Number.isFinite(prevEnd)) start = Math.max(start, prevEnd);
    }
    phaseStartedAt = Math.min(Date.now(), Math.round(start));
  }

  const upsertPayload = {
    email,
    mode: body.mode,
    running,
    phase_end_at: Number.isFinite(body.phaseEndAt) ? body.phaseEndAt : null,
    seconds_left: secondsLeft,
    total_seconds: totalSeconds,
    completed_sessions: Number.isFinite(body.completedSessions) ? body.completedSessions : 0,
    phase_started_at: phaseStartedAt,
    updated_at: new Date().toISOString(),
  };
  // Claims ownership for THIS device only when a genuinely new phase is
  // starting — a Pause/Resume/tick-sync of the SAME phase doesn't touch
  // who owns it. No token to stamp (sessionStorage unavailable, or an
  // old pre-fix tab) just means this write goes through unowned, same as
  // today's behavior — never blocks the write itself.
  // Also claims it when this device RESUMES a phase nobody is actively
  // running (paused, or past its end). Before 2026-10-04 a resume never
  // moved ownership, so a session paused in one tab and resumed in a new
  // one (browser reopened, new tab) stayed owned by the dead tab, and the
  // live tab's own next-phase write could be ignored as "another device".
  if (deviceToken && (isNewPhase || (running && !existingStillActive))) upsertPayload.owner_token = withKind(deviceToken);

  let { error } = await supabase.from('pomo_active_session').upsert(upsertPayload, { onConflict: 'email' });
  if (error && upsertPayload.owner_token) {
    // Pre-migration fallback: the column doesn't exist yet, so retry
    // without it rather than failing this routine sync entirely — the
    // same "never let a new, optional field break an existing critical
    // path" discipline used throughout this session. Once the migration
    // runs, the first attempt above succeeds directly and this never
    // triggers again.
    delete upsertPayload.owner_token;
    ({ error } = await supabase.from('pomo_active_session').upsert(upsertPayload, { onConflict: 'email' }));
  }
  if (error) return json(500, { error: error.message });

  // How long ago the server considers this phase to have started. The
  // client adopts it if it's later than its own start (e.g. the server
  // reset the start because this device's earlier write was ignored or
  // overwritten), so it never claims a completion the server would reject
  // as insufficient_elapsed. An age, not a timestamp, so client clock skew
  // doesn't matter.
  return json(200, { ok: true, phaseAgeMs: Math.max(0, Date.now() - phaseStartedAt) });
}
