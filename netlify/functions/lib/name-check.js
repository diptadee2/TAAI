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

const SYSTEM_PROMPT = 'You review display names for a GATE exam-prep leaderboard used by students in India, mostly in their early-to-mid 20s. Names should stay fun and welcoming: nicknames, anime/game/movie characters, jokes, and playful usernames are all completely fine and must NOT be flagged. Only flag a name if it is genuinely inappropriate for a public educational site any student\'s parent or teacher might see - sexually explicit, hateful or slur-based, harassing or targeting a real person, or similar. When in doubt, do NOT flag it - a false positive (blocking a harmless fun name) is worse than an occasional miss.';

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

export async function checkNameAppropriate(name) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No key configured yet — fail OPEN (never flagged), same
    // never-block-on-a-missing-optional-piece discipline this codebase
    // already applies to a pre-migration column. Every caller treats
    // this identically to "Claude looked and it's fine," not a special
    // error case to handle separately.
    return { flagged: false, reason: 'ANTHROPIC_API_KEY not configured', skipped: true };
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
        messages: [{ role: 'user', content: 'Display name to review: ' + JSON.stringify(name) }],
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
