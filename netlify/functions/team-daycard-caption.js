// POST /api/team-daycard-caption { batch, date, dayNumber, dayLength, tasks: [{subject, task_text}] }
//
// Writes a social caption for the /team "Day card" image (2026-10-09,
// direct request: "generate a caption using the claude api that contains
// the progress tracker link and also the course page link"). Admin-gated
// like every other /team endpoint, since it spends API credit.
//
// The facts it may use are passed in explicitly (the day's tasks, the day
// counter, the 70-mark plan, the 100 pe 100% off terms) and the prompt
// forbids inventing others, because this text goes out publicly under
// TAAI's name. Both links are fixed here and appended by the server if
// the model leaves either out, so a caption can never ship without them.
import { json, requireAdmin } from './lib/supabase.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5-5';
const TIMEOUT_MS = 20000;
const TRACKER_URL = 'https://taai.live/gate-da-progress-tracker?batch=D';
const COURSES_URL = 'https://taai.live/gate-da-courses';

const SYSTEM_PROMPT = `You write short social captions for TAAI, a GATE DA (Data Science and AI) prep brand in India, to go with an image of one day's tasks from TAAI's free "120 Days - 70 Marks" study plan. The image already shows the tasks, the day counter and the challenge details, so the caption should NOT repeat them as a list.

Always call it a "roadmap" (the free 120-day roadmap on the progress tracker), never a "plan". The second link is the GATE 2028 course page, where the course and its 100 pe 100% off offer live.

Voice: sounds like a real person (a mentor or a fellow aspirant) typing quickly, not a brand or an ad. Plain, direct, a little cheeky is fine. Short sentences. Lowercase starts are fine where natural. No corporate words (journey, unlock, elevate, game-changer, seamless, empower, dive in), no "Here's what...", no rhetorical lists of three, no exclamation-mark spam.

Structure:
- One intriguing first line that makes someone stop scrolling (a curious or slightly provocative thought tied to the day or the 70-mark goal). Not a question about "are you ready".
- One or two short lines that hint at the roadmap and mention the "100 pe 100% off" challenge in plain words (AIR under 100 in GATE DA 2027 gets the GATE 2028 course fee back). You may use the fact that 65 marks got AIR 90 in GATE DA 2026.
- Then the two links, each on its own line, exactly:
  Roadmap (free): ${TRACKER_URL}
  Course: ${COURSES_URL}
- Then at most 3 hashtags on the last line.

Rules:
- Under 50 words before the links (hard limit). Two or three short lines is ideal.
- Use ONLY the facts given. Never invent prices, deadlines, ranks, student numbers, results, quotes, or claims about how long the tasks take, how hard or easy a day is, or what most students do.
- Say today/tomorrow/the date exactly as described in the user message; never call a future day "today".
- Never use em dashes or en dashes. At most 1 emoji, often none.
- Output only the caption.`;

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(503, { error: 'Claude API key is not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 12) : [];
  if (!tasks.length) return json(400, { error: 'no tasks for this day' });
  const date = String(body.date || '').slice(0, 10);
  const dayNumber = Number(body.dayNumber) || 0;
  const dayLength = Number(body.dayLength) || 120;
  const batchLabel = body.batch === 'C' ? '180 Days Batch C' : '120 Days - 70 Marks';

  const taskLines = tasks.map(t => '- ' + String(t.subject || '').slice(0, 60) + ': ' + String(t.task_text || '').replace(/\s*\(Done\)\s*$/i, '').slice(0, 160)).join('\n');
  const when = body.when === 'today' ? 'today (the post goes out the same day)' : body.when === 'tomorrow' ? 'tomorrow (the post goes out the day before, as a preview)' : 'a specific date (not necessarily today or tomorrow; refer to it by its date)';
  const userContent = `Plan: ${batchLabel}
Date: ${date}, which is ${when}
Day counter: ${dayNumber > 0 ? `Day ${dayNumber} of ${dayLength}` : `Not started yet`}
Tasks for this day:
${taskLines}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        // This model thinks by default, and thinking tokens count against
        // max_tokens: at 900 the caption was cut off mid-sentence. A short
        // caption doesn't need it, so it's off, with headroom regardless.
        max_tokens: 2000,
        thinking: { type: 'between_tools' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    return json(502, { error: e.name === 'AbortError' ? 'Claude took too long, try again' : 'Could not reach Claude' });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return json(502, { error: 'Claude API error ' + res.status + ': ' + text.slice(0, 200) });
  }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') return json(502, { error: 'The caption came back cut off, try again' });
  let caption = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!caption) return json(502, { error: 'Claude returned an empty caption' });

  // House style: no em/en dashes in public copy.
  caption = caption.replace(/\s*[—–]\s*/g, ', ');
  // Guarantee both links.
  if (!caption.includes(TRACKER_URL)) caption += '\n\nRoadmap (free): ' + TRACKER_URL;
  if (!caption.includes(COURSES_URL)) caption += '\nCourse: ' + COURSES_URL;

  return json(200, { caption });
}
