// checkNameAppropriate(name) -> { flagged, reason, skipped? }
//
// A single shared helper wrapping the Claude API to classify a student's
// display name as appropriate/inappropriate for a public, educational
// leaderboard. Three different usage patterns, by design, not an
// oversight — see each call site's own comment:
//   - check-name-background.js (a Netlify Background Function, triggered
//     fire-and-forget via triggerNameCheckBackground() below) is what
//     actually reviews a brand-new registration or an ordinary voluntary
//     rename — ASYNCHRONOUSLY, a few seconds after the name was already
//     saved, never blocking the student's own request. register.js and
//     rename.js's voluntary path both save instantly with zero inline
//     call to this function at all; a flagged result gates the student
//     (needs_rename=true) rather than rejecting anything, since there's
//     nothing left to reject by the time the background function runs.
//     This event-driven design replaced an earlier 15-minute polling
//     scan the same day it shipped ("how bout there is a condition if
//     there are name changes or new signups the function gets called?")
//     — strictly better on both the latency this codebase cares about
//     (seconds, not up to 15 minutes) and the resource cost ("let's save
//     resources" — no more ~96 empty daily poll ticks).
//   - name-check-scan.js (scheduled, once daily now, see its own top
//     comment) is a SAFETY NET, not the primary path — it only ever
//     finds a candidate when a background check above genuinely failed
//     to run or write (a transient Claude/network error, a dispatch that
//     never landed), which check-name-background.js deliberately leaves
//     unrecorded specifically so this daily run can retry it.
//   - rename.js's OWN gated-resolution branch (a student who's already
//     needs_rename=true, actively trying to fix it) still calls this
//     SYNCHRONOUSLY and rejects outright if still flagged — a
//     deliberately different, stricter flow, since the whole point
//     there is confirming the new name is actually fine before letting
//     the student out of the gate; "save it and check later" doesn't
//     make sense for a moment that only exists to resolve the check.
// Plain fetch, no SDK — matches this codebase's existing lightweight
// Discord/Telegram posting helpers in this same lib/ folder, no new
// dependency for one small API call.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
// Haiku, not a bigger model — this is a simple, cheap binary
// classification call, not something that benefits from more reasoning.
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = 'You review display names for a GATE exam-prep leaderboard used by students in India, mostly in their early-to-mid 20s. Names should stay fun and welcoming: nicknames, anime/game/movie characters, jokes, and playful usernames are all completely fine and must NOT be flagged. Only flag a name if it is genuinely inappropriate for a public educational site any student\'s parent or teacher might see - sexually explicit, hateful or slur-based, harassing or targeting a real person, or similar. This applies in ANY language, not just English - the audience is Indian students, so actively watch for offensive words in Hindi and other Indian languages too, including when written in Roman/Latin script (e.g. Hinglish) rather than Devanagari, and common leetspeak-style or spaced-out obfuscations of a slur in any of these. If a name phonetically matches a known slur in Hindi or another Indian language, treat it as that slur first, even if the exact same spelling also happens to be a legitimate name in English or another context elsewhere (for example, "Randi" must be read as the Hindi slur here, not excused just because it is also a Western first name) - this audience makes the slur reading the one that matters, so a name should only be spared for having an innocent reading if it does NOT also have a real slur reading. When in doubt, do NOT flag it - a false positive (blocking a harmless fun name) is worse than an occasional miss.';

// This call sits directly in the request path of a gated rename — a
// slow or hung Claude response must never leave a student stuck staring
// at a loading spinner indefinitely (or worse, eating into Netlify's own
// function execution ceiling). Also bounds how long name-check-scan.js
// can stall on any one student mid-batch. 6s is generous for a single
// small tool-forced call under normal conditions but still leaves real
// headroom before that ceiling; a
// timeout is treated exactly like any other failure — caught by the
// caller's own try/catch, fails open.
const TIMEOUT_MS = 6000;

const TOOL = {
  name: 'classify_name',
  description: 'Classify whether a display name is inappropriate for a public educational leaderboard.',
  input_schema: {
    type: 'object',
    properties: {
      flagged: { type: 'boolean', description: 'true only if the name is genuinely inappropriate' },
      reason: { type: 'string', description: 'one short sentence explaining the call either way' },
    },
    required: ['flagged', 'reason'],
  },
};

// priorFlaggedName (optional) — the most recent name this SAME student
// already had flagged (students.last_flagged_name, see schema.sql's own
// comment for the real incident that motivated this: a name softened
// just enough between renames to read as harmless in isolation, even
// though a human who saw both names together would recognize it as the
// same joke continuing). Passed as context so Claude can reason about
// continuation/theme itself, rather than this file trying to detect the
// pattern via string-similarity, which can't judge meaning the way an
// actual comparison can.
export async function checkNameAppropriate(name, priorFlaggedName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No key configured yet — fail OPEN (never flagged), same
    // never-block-on-a-missing-optional-piece discipline this codebase
    // already applies to a pre-migration column. Every caller treats
    // this identically to "Claude looked and it's fine," not a special
    // error case to handle separately.
    return { flagged: false, reason: 'ANTHROPIC_API_KEY not configured', skipped: true };
  }

  let userContent = 'Display name to review: ' + JSON.stringify(name);
  if (priorFlaggedName) {
    userContent += '\n\nContext: this same student previously had the name ' + JSON.stringify(priorFlaggedName) +
      ' flagged as inappropriate. Consider whether the new name above might be a softened continuation of the ' +
      'same joke, theme, or issue, reworded just enough to look harmless on its own — if so, flag it and say so ' +
      'in your reason. But judge the new name primarily on its own merits: a genuinely unrelated new name from ' +
      'the same student should NOT be flagged just because of past history.';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'classify_name' },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Claude API error ' + res.status + ': ' + text.slice(0, 300));
  }

  const data = await res.json();
  const toolUse = (data.content || []).find((c) => c.type === 'tool_use' && c.name === 'classify_name');
  if (!toolUse) throw new Error('Claude did not return a classify_name tool call');
  return { flagged: !!toolUse.input.flagged, reason: toolUse.input.reason || '' };
}

// Fires check-name-background.js for (email, displayName) — used by
// register.js and rename.js's voluntary-rename branch, both of which
// save the name unconditionally FIRST and let this run the actual Claude
// check afterward, out of the request/response cycle entirely. Awaited
// only long enough to confirm Netlify accepted the background invocation
// (a near-instant 202 ack, not the real multi-second Claude round trip
// that happens after) — failing to even dispatch it is logged, not
// thrown, since a missed background check must never fail an otherwise-
// successful save; name-check-scan.js's daily safety-net run is the
// backstop for exactly this case too.
export async function triggerNameCheckBackground(event, email, displayName) {
  try {
    const proto = (event.headers && (event.headers['x-forwarded-proto'] || event.headers['X-Forwarded-Proto'])) || 'http';
    const host = event.headers && (event.headers.host || event.headers.Host);
    if (!host) return;
    const url = proto + '://' + host + '/.netlify/functions/check-name-background';
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.SUPABASE_SERVICE_KEY || '' },
      body: JSON.stringify({ email, display_name: displayName }),
    });
  } catch (e) {
    console.error('triggerNameCheckBackground: failed to dispatch for', email, e);
  }
}

// A short list of generic function words plus a few names/phrases
// common enough on THIS specific platform (GATE DA exam prep) that
// they'd otherwise create noisy, meaningless matches below — e.g. two
// totally unrelated students both using "topper" or "focused" shouldn't
// read as a connection. Deliberately NOT including pronouns (she/he/
// her/him) — those are exactly the short, meaningful words this check
// exists to catch, unlike these.
const REVIEW_NOTE_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'am', 'to', 'of', 'in', 'on', 'at', 'it', 'and', 'or', 'but', 'who',
  'what', 'when', 'where', 'why', 'how', 'this', 'that', 'for', 'with', 'not', 'you', 'your',
  'gate', 'exam', 'study', 'student', 'topper', 'focus', 'focused', 'rank', 'score', 'da',
]);

// Splits a display name into its meaningful lowercase words — handles
// the three ways this codebase's real names actually vary: CamelCase
// compounds ("SheSaidMore"), punctuation/spacing ("BUT WHOO IS
// SHEEEE..."), and elongated letter-repetition ("SHEEEE" -> "she"). The
// elongation collapse only fires on 3+ repeats specifically (not 2) —
// English spelling already has plenty of legitimate double letters
// ("letter", "common"); tripling is what actually signals deliberate
// stretching ("sheeee", "whooo"), not normal spelling.
function significantWords(name) {
  const words = String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/([a-z])\1{2,}/g, '$1')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !REVIEW_NOTE_STOPWORDS.has(w));
  return new Set(words);
}

// Cheap, no-Claude-call check: does this name share a meaningful word
// with some OTHER student's own last_flagged_name? Never gates anyone —
// see schema.sql's own comment on name_review_note for why this stays
// advisory-only rather than an auto-flag, after a real cross-student
// case (a different student's name referencing another's already-
// flagged one) turned out to read as a genuine, unrelated meme/phrase
// even when Claude was told about the connection directly. otherFlagged
// is [{email, last_flagged_name}], already fetched by the caller and
// already excluding the student being checked.
export function crossStudentReviewNote(displayName, selfEmail, otherFlagged) {
  const mine = significantWords(displayName);
  if (mine.size === 0) return null;
  for (const row of otherFlagged || []) {
    if (!row.last_flagged_name || row.email === selfEmail) continue;
    const theirs = significantWords(row.last_flagged_name);
    const shared = [...mine].filter((w) => theirs.has(w));
    if (shared.length > 0) {
      return 'Shares "' + shared[0] + '" with a previously-flagged name on another account (' + row.email + ': "' + row.last_flagged_name + '") — may be worth a look, not auto-flagged.';
    }
  }
  return null;
}

// Fetches every OTHER student's last_flagged_name — a small, bounded
// pool (only students ever flagged at least once), so a plain select is
// safe here without needing full pagination machinery. selfEmail is
// optional — omit it to fetch the whole pool once for a batch (e.g.
// name-check-scan.js checking several candidates against the same
// pool), where each candidate's own row is instead excluded later by
// crossStudentReviewNote itself. Passing `.neq('email', null)` would be
// wrong here (SQL's `!= NULL` semantics don't mean "not omitted"), so
// the exclusion is only ever applied when a real email is given.
// Best-effort: a lookup failure just means this check is skipped for
// this one run, not a reason to fail the whole name check.
export async function fetchOtherFlaggedNames(supabase, selfEmail) {
  try {
    let query = supabase.from('students').select('email, last_flagged_name').not('last_flagged_name', 'is', null).limit(500);
    if (selfEmail) query = query.neq('email', selfEmail);
    const { data } = await query;
    return data || [];
  } catch (e) {
    console.error('fetchOtherFlaggedNames: lookup failed', e);
    return [];
  }
}
