// Free All India Mini FLT promo (2026-11-23). One settings object, stored in
// site_settings.mini_flt (JSONB) and edited in /team > Site data > Settings.
// Shown as a banner on the test series page and home page, and as a strip on
// the progress tracker. DEFAULT is used until the column exists or nothing has
// been saved; keep it in sync with the copies in gate-da-test-series.html,
// index.html and progress.js.
export const MINI_FLT_DEFAULT = {
  enabled: true,
  topics: ['Linear Algebra', 'Python', 'Machine Learning'],
  url: 'https://learn.taai.live/learn/home/Mixed-Subject-Wise-Test/section/766425/lesson/4936517?embedPlayer=1&disableLessonChange=true&visitorFlow=true',
  minutes: 90,
};

// Returns { value } or { error }.
export function cleanMiniFlt(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'invalid mini FLT settings' };
  const enabled = raw.enabled === true;
  const topics = (Array.isArray(raw.topics) ? raw.topics : [])
    .map(t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (topics.length > 6) return { error: 'at most 6 topics' };
  if (topics.some(t => t.length > 40)) return { error: 'each topic must be 40 characters or fewer' };
  const url = String(raw.url || '').trim();
  if (url && !/^https:\/\/learn\.taai\.live\//.test(url)) return { error: 'the test link must start with https://learn.taai.live/' };
  if (url.length > 600) return { error: 'the test link is too long' };
  if (enabled && !topics.length) return { error: 'add at least one topic before switching it on' };
  if (enabled && !url) return { error: 'add the test link before switching it on' };
  // Test length (2026-11-23), shown as "90-minute paper" / "90 min". Older
  // saved values have none: 90.
  let minutes = raw.minutes == null || raw.minutes === '' ? 90 : Number(raw.minutes);
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 300) return { error: 'test length must be a whole number of minutes, 10 to 300' };
  return { value: { enabled, topics, url, minutes } };
}

// What the public endpoint returns, from a site_settings row (or null).
export function publicMiniFlt(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'mini_flt') || row.mini_flt == null) return MINI_FLT_DEFAULT;
  const c = cleanMiniFlt(row.mini_flt);
  return c.value || MINI_FLT_DEFAULT;
}

// The rolling strip at the top of the pages (2026-11-23), stored in
// site_settings.top_strip (JSONB, manual SQL in schema.sql). mode 'mini_flt':
// built from the Mini FLT setting, a tap opens the Mini FLT card. mode
// 'custom': your own message + button text + link, a tap goes to the link.
// style 'light' (yellow) or 'dark' on the main pages; the tracker is always dark.
export const TOP_STRIP_DEFAULT = { enabled: true, mode: 'mini_flt', message: '', button: '', url: '', style: 'light' };

export function cleanTopStrip(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'invalid strip settings' };
  const enabled = raw.enabled === true;
  const mode = raw.mode === 'custom' ? 'custom' : 'mini_flt';
  const style = raw.style === 'dark' ? 'dark' : 'light';
  const message = String(raw.message || '').replace(/\s+/g, ' ').trim();
  const button = String(raw.button || '').replace(/\s+/g, ' ').trim();
  const url = String(raw.url || '').trim();
  if (message.length > 200) return { error: 'the message must be 200 characters or fewer' };
  if (button.length > 30) return { error: 'the button text must be 30 characters or fewer' };
  if (url && !/^https:\/\//.test(url) && !/^\/[^/]/.test(url)) return { error: 'the link must start with https:// or be a page on this site like /gate-da-courses' };
  if (url.length > 600) return { error: 'the link is too long' };
  if (enabled && mode === 'custom' && !message) return { error: 'add the message before switching the strip on' };
  if (enabled && mode === 'custom' && !url) return { error: 'add the link before switching the strip on' };
  return { value: { enabled, mode, message, button, url, style } };
}

export function publicTopStrip(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'top_strip') || row.top_strip == null) return TOP_STRIP_DEFAULT;
  const c = cleanTopStrip(row.top_strip);
  return c.value || TOP_STRIP_DEFAULT;
}
