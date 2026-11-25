// "Video ideas for TAAI" (2026-11-25), /team > Competitors > YouTube.
// Takes the competitor videos of the last N days, measures each against its
// own channel's usual views, and asks Claude what's working and which videos
// TAAI could make now. Runs in competitors-refresh-background.js (it takes
// longer than Netlify's ~10s request limit); the result is kept as
// ideas-<days>.json in the private storage bucket "competitor-insights".
//
// Raw HTTP to the Messages API, the same way lib/name-check.js calls it (the
// project has no Anthropic SDK dependency).

const BUCKET = 'competitor-insights';
const MODEL = 'claude-opus-5-5';

function median(a) {
  a = a.filter(x => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Each channel's usual views per kind (long video / Short / live): the median
// over its videos of the last 30 days that are at least a day old.
// perDay (windows of 3 days or less): views per day instead of total views,
// so a video posted yesterday isn't judged against week-old totals.
const valueOf = (v, now, perDay) => perDay ? (v.views || 0) / Math.max(1, (now - Date.parse(v.published_at)) / 86400000) : (v.views || 0);
export function channelBaselines(videos, now = Date.now(), perDay = false) {
  // Per day, compare with the channel's other recent videos (1 to 7 days
  // old; all 30 days if it has fewer than 3): older videos' daily views have
  // faded, which would make ordinary new uploads look like big hits.
  const groups = {}, recent = {};
  for (const v of videos) {
    const age = now - Date.parse(v.published_at);
    if (age < 86400000) continue;
    const k = v.channel_id + '|' + (v.kind || 'video');
    (groups[k] = groups[k] || []).push(valueOf(v, now, perDay));
    if (age <= 7 * 86400000) (recent[k] = recent[k] || []).push(valueOf(v, now, perDay));
  }
  if (perDay) for (const k in recent) if (recent[k].length >= 3) groups[k] = recent[k];
  const out = {};
  for (const k in groups) out[k] = median(groups[k]);
  return out;
}

export function videoScore(v, base, now = Date.now(), perDay = false) {
  const b = base[v.channel_id + '|' + (v.kind || 'video')];
  return b ? valueOf(v, now, perDay) / b : null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    working: {
      type: 'array',
      items: {
        type: 'object',
        properties: { pattern: { type: 'string' }, evidence: { type: 'string' } },
        required: ['pattern', 'evidence'], additionalProperties: false,
      },
    },
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          format: { type: 'string', enum: ['Short', 'Long video', 'Live'] },
          hook: { type: 'string' },
          why: { type: 'string' },
          based_on: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'format', 'hook', 'why', 'based_on'], additionalProperties: false,
      },
    },
  },
  required: ['summary', 'working', 'ideas'], additionalProperties: false,
};

const SYSTEM = `You help TAAI, a small Indian GATE DA (Data Science and AI) exam-prep company, plan its YouTube videos. You get the competitor and TAAI videos published in a recent period, with how each did against its own channel's usual views (score 2.0 = twice that channel's median for that format). Raw view counts favour big channels, so judge by the score.

Return:
- summary: two or three plain sentences on what audiences are watching right now.
- working: 3 to 6 patterns (topic, angle or format) that clearly beat their channel's usual, each with evidence naming specific videos and their scores. Only patterns the data supports.
- ideas: 6 to 8 videos TAAI could make in the next week or two. TAAI teaches GATE DA (probability, statistics, linear algebra, calculus, Python, DSA, DBMS, machine learning, AI) with recorded lectures, a free daily progress tracker, test series and the "100 pe 100% off" challenge (AIR under 100 in GATE DA 2027 refunds the GATE 2028 course fee). Each idea: a title as it would appear on YouTube, the format, the first line spoken in the video (hook), why it should work given this data, and the titles of the competitor videos it is based on. Make them GATE DA specific and different from what TAAI already posted. Never copy a competitor title; never promise ranks or results.

Write in plain English, no em dashes.`;

async function callClaude(userText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + ((body && body.error && body.error.message) || 'request failed'));
  if (body.stop_reason === 'refusal') throw new Error('Claude declined this request');
  if (body.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing');
  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { result: JSON.parse(text), model: body.model };
}

export async function buildVideoIdeas(s, days) {
  days = [1, 3, 7, 30].includes(Number(days)) ? Number(days) : 3;
  const perDay = days <= 3;
  const now = Date.now();
  const { data: channels, error } = await s.from('yt_channels').select('channel_id, label, title, is_us, active');
  if (error) throw error;
  const chan = {}; for (const c of channels || []) chan[c.channel_id] = c;
  const since30 = new Date(now - 30 * 86400000).toISOString();
  const videos = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await s.from('yt_videos').select('video_id, channel_id, title, published_at, kind, views, likes, comments')
      .gte('published_at', since30).range(from, from + 999);
    videos.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const base = channelBaselines(videos, now, perDay);
  const fromT = now - days * 86400000;
  const rows = videos.filter(v => chan[v.channel_id] && chan[v.channel_id].active && Date.parse(v.published_at) >= fromT)
    .map(v => ({ v, score: videoScore(v, base, now, perDay), age: (now - Date.parse(v.published_at)) / 86400000 }));
  const ours = rows.filter(r => chan[r.v.channel_id].is_us);
  const theirs = rows.filter(r => !chan[r.v.channel_id].is_us).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 60);
  if (!theirs.length) throw new Error('No competitor videos in this period yet');
  const line = r => '- ' + JSON.stringify({
    channel: chan[r.v.channel_id].label || chan[r.v.channel_id].title, title: r.v.title, format: r.v.kind || 'video',
    days_old: Math.round(r.age * 10) / 10, views: r.v.views, score: r.score == null ? null : Math.round(r.score * 10) / 10,
    comments: r.v.comments,
  });
  const userText = 'Period: the last ' + (days === 1 ? '24 hours' : days + ' days') + '. ' +
    (perDay ? 'This is a short window to catch what is trending right now: score compares each video\'s views per day with its channel\'s usual views per day. Suggest ideas TAAI can shoot and publish within the next 3 to 5 days, while these topics are still hot. ' : '') +
    'Videos under a day old have not settled yet, weigh their scores lightly.\n\n' +
    'Competitor videos, best score first:\n' + theirs.map(line).join('\n') +
    '\n\nTAAI videos in the same period:\n' + (ours.length ? ours.map(line).join('\n') : '- none');
  const { result, model } = await callClaude(userText);
  const doc = { generatedAt: new Date().toISOString(), days, model, videosConsidered: theirs.length, ...result };
  await s.storage.createBucket(BUCKET, { public: false }).catch(() => {});
  const { error: upErr } = await s.storage.from(BUCKET).upload('ideas-' + days + '.json', JSON.stringify(doc), { contentType: 'application/json', upsert: true });
  if (upErr) throw upErr;
  return doc;
}

export async function readVideoIdeas(s, days) {
  const { data } = await s.storage.from(BUCKET).download('ideas-' + days + '.json');
  if (!data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}
