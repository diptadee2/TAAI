// checkNameAppropriate(name) -> { flagged, reason, skipped? }
//
// A single shared helper wrapping the Claude API to classify a student's
// display name as appropriate/inappropriate for a public, educational
// leaderboard. Used by two call sites: rename.js (the NEW name a
// needs_rename-flagged student submits, so they can't dodge the gate
// with a different-but-still-bad name) and name-check-scan.js (a
// scheduled scan, every 5 minutes, covering every not-yet-flagged
// student whose name has changed since it was last checked — this is
// what covers a brand-new registration, since register.js itself
// deliberately never calls Claude at all: a brand-new signup has no
// leaderboard visibility until real focus time is logged, so there's no
// urgency to block or slow down the signup response itself). Plain
// fetch, no SDK — matches this codebase's existing lightweight Discord/
// Telegram posting helpers in this same lib/ folder, no new dependency
// for one small API call.
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
