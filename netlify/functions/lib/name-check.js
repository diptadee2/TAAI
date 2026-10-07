// checkNameAppropriate(name) -> { flagged, reason, skipped? }
//
// A single shared helper wrapping the Claude API to classify a student's
// display name as appropriate/inappropriate for a public, educational
// leaderboard. Three different usage patterns, by design, not an
// oversight — see each call site's own comment:
//   - check-name-background.js (a Netlify Background Function, triggered
//     fire-and-forget via triggerNameCheckBackground() below) is what
//     actually reviews a brand-new registration — ASYNCHRONOUSLY, a few
//     seconds after the name was already saved, never blocking the
//     student's own request. register.js saves instantly with zero
//     inline call to this function at all; a flagged result gates the
//     student (needs_rename=true) rather than rejecting anything, since
//     there's nothing left to reject by the time the background
//     function runs. This event-driven design replaced an earlier
//     15-minute polling scan the same day it shipped ("how bout there is
//     a condition if there are name changes or new signups the function
//     gets called?") — strictly better on both the latency this
//     codebase cares about (seconds, not up to 15 minutes) and the
//     resource cost ("let's save resources" — no more ~96 empty daily
//     poll ticks).
//   - rename.js's voluntary-rename branch (an ordinary, non-gated
//     student renaming for fun) calls this SYNCHRONOUSLY too, in the
//     same request that saves the new name — direct follow-up request
//     ("put it to claude check right after rename is done and then let
//     them use the timer"), so the student sees a real "Checking…" state
//     and finds out immediately whether they're now gated, rather than
//     discovering it invisibly a few seconds later. The name is still
//     saved unconditionally either way; a flagged result just means the
//     SAME response that confirms the save also already carries
//     needs_rename=true.
//   - name-check-scan.js (scheduled, once daily now, see its own top
//     comment) is a SAFETY NET, not the primary path — it only ever
//     finds a candidate when register.js's background check above
//     genuinely failed to run or write (a transient Claude/network
//     error, a dispatch that never landed), or when a synchronous
//     check anywhere threw before it could record anything.
//   - rename.js's OWN gated-resolution branch (a student who's already
//     needs_rename=true, actively trying to fix it) also calls this
//     SYNCHRONOUSLY and rejects outright if still flagged — a
//     deliberately different, stricter flow from the voluntary branch
//     above, since the whole point there is confirming the new name is
//     actually fine before letting the student out of the gate; a
//     voluntary rename never rejects, it only gates afterward.
// Plain fetch, no SDK — matches this codebase's existing lightweight
// Discord/Telegram posting helpers in this same lib/ folder, no new
// dependency for one small API call.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
// Haiku, not a bigger model — this is a simple, cheap binary
// classification call, not something that benefits from more reasoning.
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = 'You review display names for a GATE exam-prep leaderboard used by students in India, mostly in their early-to-mid 20s. Names should stay fun and welcoming: nicknames, anime/game/movie characters, jokes, and playful usernames are all completely fine and must NOT be flagged. Only flag a name if it is genuinely inappropriate for a public educational site any student\'s parent or teacher might see - sexually explicit, hateful or slur-based, harassing or targeting a real person, or similar. This applies in ANY language, not just English - the audience is Indian students, so actively watch for offensive words in Hindi and other Indian languages too, including when written in Roman/Latin script (e.g. Hinglish) rather than Devanagari, and common leetspeak-style or spaced-out obfuscations of a slur in any of these. If a name phonetically matches a known slur in Hindi or another Indian language, treat it as that slur first, even if the exact same spelling also happens to be a legitimate name in English or another context elsewhere (for example, "Randi" must be read as the Hindi slur here, not excused just because it is also a Western first name; "Maghiya"/"maghiya"/"MAGHIYA" must all be read as the Hindi slur here too, not excused for reading as a plausible-sounding proper name in Title Case) - this audience makes the slur reading the one that matters, so a name should only be spared for having an innocent reading if it does NOT also have a real slur reading. This judgment must NEVER depend on capitalization - a word\'s casing (all-lowercase, Title Case, or ALL CAPS) never makes a phonetic slur match more or less legitimate-looking or more or less deserving of being excused; judge the sound/spelling of the word itself, the same way, in every casing it could be typed in. If you would flag a lowercase spelling of a word, you must also flag the exact same word capitalized, and vice versa - do not let Title Case alone make something read as "a proper name" when the same letters in lowercase would correctly be read as a slur. Also watch for near-miss spellings of a known slur where the WHOLE word\'s structure - length, syllable count, and ending - closely matches the slur, with just one small substitution near the start (e.g. "brosdike"/"Brosdike"/"BROSDIKE" all match "bhosdike" the same way - same "-sdike" ending, same length, only "bho"->"bro" changed - capitalization must NOT change this judgment either way, lowercase is not more innocent than any other casing). Judge the FULL word\'s resemblance, not just a shared prefix or individual syllable - a word that only shares a common opening sound with part of a slur (like "bro-" in ordinary words such as "broskie", "brother", "bronze", "brotherhood") is NOT a slur near-miss just because of that; it has to closely resemble the slur\'s complete structure, not merely start similarly. IMPORTANT: do not let a lowercase or casual-looking style make a near-miss slur seem more innocent or more like ordinary internet slang - "brosdike" in all-lowercase is exactly as much a near-miss of "bhosdike" as "Brosdike" or "BROSDIKE" are, and must be flagged the same way; casing and casualness of style are not evidence of innocent intent for a word that otherwise structurally matches a known slur. CASTE TERMS ARE NOT ALLOWED (a rule of this site): always flag "chamar" in any spelling, spacing or casing (e.g. "Chamar", "CHAMAR", "chamaar", "ch@mar", "rahul_chamar", "Rahul Chamar"), even when it reads as a real surname or community name, and flag other caste-based slurs or casteist insults the same way. POLITICAL CONTENT IS NOT ALLOWED (a rule of this site, regardless of tone): flag anything that clearly references politics - a politician or political leader by a recognisable name or handle (e.g. "Narendra Modi", "Modi ji", "Rahul Gandhi", "Akhilesh Yadav", "Kejriwal", "Yogi" used as the CM), a political party or its abbreviation/symbol (BJP, Congress, AAP, SP, TMC, etc.), political slogans or chants, election/vote-bank references, and political memes or nicknames for politicians (e.g. "Pappu", "Feku", "Chowkidar", "Kab aaoge mere Akhilesh"), whether praising or mocking, in any language or spelling. Do NOT flag an ordinary personal name that merely happens to match a politician\'s first name (a student called "Rahul", "Akhilesh Kumar", "Narendra S", or "Mamta" is fine): only flag when the text is clearly about the political figure or politics. When in doubt, do NOT flag it - a false positive (blocking a harmless fun name) is worse than an occasional miss.';

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

  return classifyWithClaude(apiKey, SYSTEM_PROMPT, userContent);
}

// The one shared Claude round trip behind every classifier in this file
// (display names above, leaderboard About text below) — same model,
// same forced classify_name tool call, same timeout/temperature, so the
// two checks can never drift apart on anything but their own prompt.
async function classifyWithClaude(apiKey, systemPrompt, userContent, tool = TOOL) {
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
        // temperature: 0 — this is a classification task, not creative
        // writing; the same name should reliably get the same verdict
        // every time. Confirmed this actually mattered, not just
        // theoretically correct: without it, a genuinely borderline
        // near-miss slur spelling (a deliberate letter-substitution
        // dodge, e.g. "brosdike" for "bhosdike") flip-flopped roughly
        // 50/50 flagged/not-flagged across repeated identical calls at
        // the default temperature — the same exact input, no other
        // change, landing on opposite verdicts.
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        tools: [tool],
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

// Leaderboard "About" text (the short WhatsApp-style status a student can
// show as a chat bubble beside their name on the weekly top-20 board —
// see set-about.js). A separate prompt from SYSTEM_PROMPT rather than
// reusing it: that one is tuned hard for single-word/username slur
// matching, while an About is a short free-text sentence with its own
// failure modes (targeting another student by name, self-promotion,
// contact details). The Indian-language slur rules carry over in spirit.
const ABOUT_SYSTEM_PROMPT = 'You review short "About" status texts (like a WhatsApp About line, max 80 characters) that students show beside their name on a public GATE exam-prep leaderboard used by students in India, mostly in their early-to-mid 20s. Keep it fun: motivational lines, jokes, memes, song/anime/movie quotes, study moods, emojis, and playful banter are all completely fine and must NOT be flagged. Flag the text only if it is genuinely inappropriate for a public educational site any student\'s parent or teacher might see: sexually explicit or suggestive content, hateful or slur-based content, harassment, insults or mockery aimed at another student or a real identifiable person, threats, encouragement of self-harm, promotion of cheating or piracy, or advertising/spam - including phone numbers, email addresses, social media handles, invite links, or any URL. This applies in ANY language: actively watch for offensive words in Hindi and other Indian languages, including Roman-script/Hinglish spellings, leetspeak, spacing tricks, and near-miss misspellings of a known slur - and never let capitalization or a casual style make a slur look more innocent. Common Hindi abuse abbreviations such as bsdk, bc, mc, bkl, mkc, tmkc, bhenchod/bsdk variants, and the like are abuse, not friendly banter - flag them even when mixed into an otherwise-motivational line like "bsdk padh le"; never invent an innocent expansion for such an abbreviation. The one exception is when the letters plainly carry their ordinary academic meaning in context, e.g. "MC questions"/"MCQ" (multiple choice) or "400 BC" (a date); those are fine. Also read the text backwards: a slur or abuse spelled in reverse (e.g. "ayituhc") is the same slur and must be flagged. CASTE TERMS ARE NOT ALLOWED (a rule of this site): always flag "chamar" in any spelling, spacing or casing (e.g. "Chamar", "CHAMAR", "chamaar", "ch@mar", "rahul_chamar", "Rahul Chamar"), even when it reads as a real surname or community name, and flag other caste-based slurs or casteist insults the same way. POLITICAL CONTENT IS NOT ALLOWED (a rule of this site, regardless of tone): flag anything that clearly references politics - a politician or political leader by a recognisable name or handle (e.g. "Narendra Modi", "Modi ji", "Rahul Gandhi", "Akhilesh Yadav", "Kejriwal", "Yogi" used as the CM), a political party or its abbreviation/symbol (BJP, Congress, AAP, SP, TMC, etc.), political slogans or chants, election/vote-bank references, and political memes or nicknames for politicians (e.g. "Pappu", "Feku", "Chowkidar", "Kab aaoge mere Akhilesh"), whether praising or mocking, in any language or spelling. Do NOT flag an ordinary personal name that merely happens to match a politician\'s first name (a student called "Rahul", "Akhilesh Kumar", "Narendra S", or "Mamta" is fine): only flag when the text is clearly about the political figure or politics. When genuinely in doubt about harmless text, do NOT flag it.';

const ABOUT_TOOL = {
  name: 'classify_name',
  description: 'Classify whether a short About/status text is inappropriate for a public educational leaderboard.',
  input_schema: TOOL.input_schema,
};

// checkAboutAppropriate(text) -> { flagged, reason, skipped? }
// Same "skipped" contract as checkNameAppropriate for a missing API key —
// but set-about.js deliberately fails CLOSED on it (refuses to save),
// unlike every name path: an About is purely optional flair, so "can't
// verify right now, try later" costs nothing, while the whole point of
// this feature is that nothing reaches the board unreviewed.
// priorFlaggedAbout: the student's most recently rejected About, if any.
// Same "give Claude the memory it's missing" idea as the name check's
// priorFlaggedName: a softened re-try of a rejected joke can look harmless
// on its own but isn't, given what came right before it.
export async function checkAboutAppropriate(text, priorFlaggedAbout) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { flagged: false, reason: 'ANTHROPIC_API_KEY not configured', skipped: true };
  let userContent = 'About text to review: ' + JSON.stringify(text);
  if (priorFlaggedAbout) {
    userContent += '\n\nContext: this same student\'s previous About ' + JSON.stringify(priorFlaggedAbout) +
      ' was rejected as inappropriate. If the new text is a softened or reworded continuation of the same joke, ' +
      'theme, or target, flag it and say so. Otherwise judge it on its own merits; an unrelated new text should ' +
      'not be flagged just because of that history.';
  }
  return classifyWithClaude(apiKey, ABOUT_SYSTEM_PROMPT, userContent, ABOUT_TOOL);
}

// What's checked must be exactly what's displayed: NFKC folds fullwidth
// and other compatibility characters to plain ones, and invisible format
// characters (zero-width spaces/joiners, direction marks, soft hyphens)
// are removed, so they can't hide a word from the check or ride along
// invisibly into the leaderboard.
export function normalizeAboutText(s) {
  return String(s || '').normalize('NFKC').replace(/[\p{Cf}\u00AD]/gu, '').replace(/\s+/g, ' ').trim();
}

// Fires check-name-background.js for (email, displayName) — used by
// register.js only (rename.js's voluntary-rename branch runs its own
// synchronous check inline now instead, see this file's top comment),
// which saves the name unconditionally FIRST and lets this run the
// actual Claude check afterward, out of the request/response cycle
// entirely. Awaited
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
