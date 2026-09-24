// checkNameAppropriate(name) -> { flagged, reason, skipped? }
//
// A single shared helper wrapping the Claude API to classify a student's
// display name as appropriate/inappropriate for a public, educational
// leaderboard. Two different usage patterns, by design, not an
// oversight — see each call site's own comment:
//   - name-check-scan.js (a scheduled function, every 15 minutes) is
//     what checks a brand-new registration or an ordinary voluntary
//     rename — ASYNCHRONOUSLY, well after the name was already saved.
//     register.js and rename.js's voluntary path both save instantly
//     with zero inline call to this function at all; a flagged result
//     here gates the student (needs_rename=true) rather than rejecting
//     anything, since there's nothing left to reject by the time this
//     runs. This is the restored design after a same-day back-and-forth
//     — briefly replaced with a fully-synchronous check-then-reject at
//     both save sites, then reverted on direct correction ("save the
//     name whatever it is instantly, while putting it on check — if it
//     comes back with inappropriateness then gate the student").
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
