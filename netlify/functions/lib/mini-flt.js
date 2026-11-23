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
  return { value: { enabled, topics, url } };
}

// What the public endpoint returns, from a site_settings row (or null).
export function publicMiniFlt(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'mini_flt') || row.mini_flt == null) return MINI_FLT_DEFAULT;
  const c = cleanMiniFlt(row.mini_flt);
  return c.value || MINI_FLT_DEFAULT;
}
