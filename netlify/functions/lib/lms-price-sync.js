// Keeps site_pricing.price in step with the price students actually pay on
// the LMS (learn.taai.live, run on Learnyst), added 2026-10-16.
//
// Rule ("last change wins"): we never compare the LMS price with the
// site's price directly. We compare it with the LMS price WE SAW LAST TIME
// (lms_price_sync.lms_price). If the LMS price moved since then, someone
// just changed it on the LMS, which is newer than any /team edit made
// before now, so the site takes the new price. If it didn't move, nothing
// happens, so a price set by hand in /team stays until the LMS changes
// again. The first time a course is seen, its LMS price is only recorded
// (a baseline); the site is not touched.
//
// Called from discord-dispatch.js (every 15 minutes, no extra cron) and
// from lms-price-check.js (/team's "Check LMS now" button).
//
// Learnyst's public GraphQL (the same one the LMS pages and our tracker's
// lesson links use, no login needed):
//   productMetadata(seoTitle) -> product id    (only when the id isn't cached)
//   showProduct(id).defaultProductPricing -> price (list) / discountPrice (what you pay)

const LMS_API = 'https://apig.learnyst.com/learn';
const SCHOOL_ID = '182642';
const REQUEST_TIMEOUT_MS = 6000;
// A private / sold-out course (e.g. the 2027 Full Course) has no public
// product; don't look it up again on every run.
const UNAVAILABLE_RETRY_MS = 24 * 60 * 60 * 1000;
// Sanity check: a new LMS price outside 0.5x..2x of the site's current
// price is held for review instead of applied (a broken read or a typo on
// the LMS must not put ₹0 or ₹99,999 on the site).
const MIN_RATIO = 0.5;
const MAX_RATIO = 2;
const RUN_ROW_ID = '__run__';

async function lmsQuery(query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(LMS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
    const body = await res.json();
    if (body.errors || body.message) throw new Error(body.message || (body.errors[0] && body.errors[0].message) || 'LMS error');
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

// https://learn.taai.live/learn/Statistics -> 'Statistics'
// https://learn.taai.live/learn/batch/GATE-2028/content -> 'GATE-2028'
export function lmsSlugFromUrl(url) {
  if (!url) return null;
  const m = /^https:\/\/learn\.taai\.live\/learn\/(?:batch\/)?([^/?#]+)/.exec(url.trim());
  return m ? decodeURIComponent(m[1]) : null;
}

async function resolveProductId(slug) {
  const data = await lmsQuery(
    'query M($s:[String!]){ productMetadata(schoolId:182642, seoTitle:$s){ id } }',
    { s: [slug] }
  );
  const row = data && data.productMetadata && data.productMetadata[0];
  return row ? String(row.id) : null;
}

async function fetchLmsPrice(productId) {
  const data = await lmsQuery(
    'query P($id:ID){ showProduct(schoolId:"' + SCHOOL_ID + '", id:$id){ defaultProductPricing{ price discountPrice } } }',
    { id: productId }
  );
  const p = data && data.showProduct && data.showProduct.defaultProductPricing;
  if (!p) return null;
  const pay = p.discountPrice != null ? p.discountPrice : p.price;
  const n = Math.round(Number(pay));
  return Number.isFinite(n) ? { price: n, listPrice: p.price != null ? Math.round(Number(p.price)) : null } : null;
}

// Keeps a numeric discount % consistent with the new price against the
// site's own MRP (price_old). Custom text discounts ("SAVE BIG") are left alone.
function recomputeDiscount(discount, price, priceOld) {
  if (discount == null || !/^\d+$/.test(String(discount).trim())) return discount;
  if (!priceOld || priceOld <= price) return discount;
  return String(Math.round((1 - price / priceOld) * 100));
}

async function logChange(supabase, entry) {
  try {
    await supabase.from('lms_price_log').insert(entry);
  } catch (e) { /* the log is informational; never fail the sync over it */ }
}

// deadline: epoch ms after which no new course is started (the scheduled
// function has a hard time limit; leftovers are simply checked next run).
export async function syncLmsPrices(supabase, { deadline = Date.now() + 20000 } = {}) {
  const startedAt = new Date();
  const [{ data: courses, error: coursesErr }, { data: syncRows, error: syncErr }] = await Promise.all([
    supabase.from('site_pricing').select('id, name, price, price_old, discount, enroll_url'),
    supabase.from('lms_price_sync').select('*'),
  ]);
  if (coursesErr) throw new Error(coursesErr.message);
  // Before the migration runs, lms_price_sync doesn't exist: skip quietly.
  if (syncErr) return { skipped: 'lms_price_sync not available: ' + syncErr.message };

  const syncById = {};
  for (const r of syncRows || []) syncById[r.id] = r;

  const results = [];
  for (const course of courses || []) {
    if (Date.now() > deadline) { results.push({ id: course.id, status: 'deferred' }); continue; }
    const slug = lmsSlugFromUrl(course.enroll_url);
    if (!slug) continue; // no LMS link: nothing to sync
    const prev = syncById[course.id] || null;
    const nowIso = new Date().toISOString();
    try {
      // Private/sold-out course: only retry the lookup once a day.
      if (prev && prev.status === 'unavailable' && prev.slug === slug &&
          prev.checked_at && Date.now() - new Date(prev.checked_at).getTime() < UNAVAILABLE_RETRY_MS) {
        results.push({ id: course.id, status: 'unavailable' });
        continue;
      }

      let productId = prev && prev.slug === slug ? prev.lms_product_id : null;
      if (!productId) productId = await resolveProductId(slug).catch(() => null);
      if (!productId) {
        await supabase.from('lms_price_sync').upsert({ id: course.id, slug, lms_product_id: null, status: 'unavailable', checked_at: nowIso, note: 'Not public on the LMS (private or not found)' });
        results.push({ id: course.id, status: 'unavailable' });
        continue;
      }

      const lms = await fetchLmsPrice(productId);
      if (!lms) throw new Error('no price on the LMS product');

      // First sighting (or the course's LMS link changed): baseline only.
      if (!prev || prev.lms_price == null || prev.slug !== slug) {
        await supabase.from('lms_price_sync').upsert({
          id: course.id, slug, lms_product_id: productId, lms_price: lms.price, lms_list_price: lms.listPrice,
          status: 'baseline', checked_at: nowIso, changed_at: null,
          note: lms.price === course.price ? null : 'LMS ₹' + lms.price + ' vs site ₹' + course.price + ' (site left as is)',
        });
        results.push({ id: course.id, status: 'baseline', lms: lms.price, site: course.price });
        continue;
      }

      // LMS price unchanged since last run: nothing to do, no write.
      if (lms.price === prev.lms_price) {
        results.push({ id: course.id, status: 'unchanged' });
        continue;
      }

      // The LMS price moved since last time.
      const oldSite = course.price;
      let status, applied = false, note = null;
      if (oldSite === lms.price) {
        status = 'matched'; note = 'Site already had this price';
      } else if (!(lms.price > 0) || (oldSite > 0 && (lms.price < oldSite * MIN_RATIO || lms.price > oldSite * MAX_RATIO))) {
        status = 'held'; note = 'LMS ₹' + prev.lms_price + ' → ₹' + lms.price + ' looks too large a jump; not applied, check and set it in /team if right';
      } else {
        const update = { price: lms.price, discount: recomputeDiscount(course.discount, lms.price, course.price_old), updated_at: nowIso };
        // Guarded on the price we just read, so a /team edit landing in the
        // same moment isn't overwritten.
        let q = supabase.from('site_pricing').update(update).eq('id', course.id);
        q = oldSite == null ? q.is('price', null) : q.eq('price', oldSite);
        const { data: upd, error: updErr } = await q.select('id');
        if (updErr) throw new Error(updErr.message);
        applied = !!(upd && upd.length);
        status = applied ? 'applied' : 'skipped';
        if (!applied) note = 'Site price changed at the same moment; left as is';
      }

      await supabase.from('lms_price_sync').upsert({
        id: course.id, slug, lms_product_id: productId, lms_price: lms.price, lms_list_price: lms.listPrice,
        status, checked_at: nowIso, changed_at: nowIso, note,
      });
      await logChange(supabase, {
        course_id: course.id, course_name: course.name, lms_old: prev.lms_price, lms_new: lms.price,
        site_old: oldSite, site_new: applied ? lms.price : oldSite, status, note,
      });
      results.push({ id: course.id, status, lms: lms.price, site: oldSite });
    } catch (err) {
      results.push({ id: course.id, status: 'error', error: err.message });
    }
  }

  // One small write per run, so /team can show when the LMS was last checked.
  const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  try {
    await supabase.from('lms_price_sync').upsert({
      id: RUN_ROW_ID, checked_at: startedAt.toISOString(), status: 'run',
      note: Object.entries(summary).map(([k, v]) => k + ' ' + v).join(', '),
    });
  } catch (e) { /* informational only */ }

  return { results, summary };
}

export { RUN_ROW_ID };
