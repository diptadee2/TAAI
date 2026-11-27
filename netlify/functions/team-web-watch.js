// /team > Competitors > Websites (2026-11-25). Admin only.
// GET  /api/team-web-watch -> { ready, pages, changes (last 90 days), offers: {page_id: [...]}, newPages }
// GET  /api/team-web-watch?change=<id> -> { change } with its full detail
// POST {action:'check', id?}            -> one page now, or all pages in the background ({started, at})
// POST {action:'add', url, competitor, label, extractor, match}
// POST {action:'remove'|'restore', id}  -> stop / restart watching (history kept)
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { runWebMonitor, isNoiseChange, isMinorText, isTrivialLine, offerCurrency } from './lib/web-monitor.js';
import { startCompetitorsRefresh } from './competitors-refresh-background.js';

const EXTRACTORS = ['text', 'gfg', 'pw', 'sitemap'];

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  const s = getSupabase();

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q.change) {
      const { data, error } = await s.from('web_changes').select('*').eq('id', q.change).maybeSingle();
      if (error) return json(500, { error: error.message });
      return json(200, { change: data });
    }
    // Price history (2026-11-27): every saved snapshot's offers (a snapshot
    // is only saved when something on the page changed), without the page
    // text, for the price chart and sale calendar.
    if (q.history) {
      const since = new Date(Date.now() - 365 * 86400000).toISOString();
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: he } = await s.from('web_snapshots').select('page_id, taken_at, offers').gte('taken_at', since).order('taken_at').range(from, from + 999);
        if (he) return json(500, { error: he.message });
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return json(200, { history: rows });
    }
    const { data: pages, error } = await s.from('web_pages').select('*').order('sort').order('id');
    if (error) return json(200, { ready: false, error: error.message });
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    // Details (added/removed lines) are fetched one change at a time, so the
    // list stays small; offers and short details come along.
    // detail is read to classify each change (noise / minor) and to send the
    // price pair, but the text lines themselves stay on the server.
    const { data: rawChanges } = await s.from('web_changes').select('id, page_id, detected_at, kind, summary, detail')
      .gte('detected_at', since).order('detected_at', { ascending: false }).limit(600);
    // A check that compared offers read two different ways (older code read
    // prices without the v:2 format, e.g. the 2026-11-26 run) reports every
    // offer as new or gone: all offer rows from that page and moment are noise.
    const mixed = new Set();
    (rawChanges || []).forEach(c => { if (c.kind === 'offer_new' && c.detail && c.detail.offer && c.detail.offer.v !== 2) mixed.add(c.page_id + '|' + c.detected_at); });
    // A check where offers only disappeared and nothing appeared, and the page
    // then showed no prices at all, was a bad read (see runWebMonitor).
    const newAt = new Set((rawChanges || []).filter(c => c.kind === 'offer_new' || c.kind === 'price').map(c => c.page_id + '|' + c.detected_at));
    const goneAt = [...new Set((rawChanges || []).filter(c => c.kind === 'offer_gone').map(c => c.page_id + '|' + c.detected_at))].filter(k => !newAt.has(k));
    if (goneAt.length) {
      const { data: snaps } = await s.from('web_snapshots').select('page_id, taken_at, offers').gte('taken_at', since).in('page_id', [...new Set(goneAt.map(k => +k.split('|')[0]))]);
      goneAt.forEach(k => {
        const [pid, at] = k.split('|');
        const snap = (snaps || []).filter(x => String(x.page_id) === pid && Math.abs(Date.parse(x.taken_at) - Date.parse(at)) < 120000)[0];
        if (snap && !(snap.offers || []).some(o => o.source !== 'text')) mixed.add(k);
      });
    }
    const changes = (rawChanges || []).map(c => {
      const d = c.detail || {};
      const burst = (c.kind === 'offer_new' || c.kind === 'offer_gone') && mixed.has(c.page_id + '|' + c.detected_at);
      const out = { id: c.id, page_id: c.page_id, detected_at: c.detected_at, kind: c.kind, summary: c.summary, noise: burst || isNoiseChange(c) };
      if (c.kind === 'text') out.minor = d.minor != null ? !!d.minor : isMinorText((d.added || []).filter(l => !isTrivialLine(l)), (d.removed || []).filter(l => !isTrivialLine(l)));
      if (c.kind === 'price' && d.from && d.to) out.price = { from: d.from.price, to: d.to.price, mrp: d.to.mrp, cur: offerCurrency(d.to), name: d.to.name || d.to.product, dir: d.dir };
      if ((c.kind === 'offer_new' || c.kind === 'offer_gone') && d.offer) out.offer = { name: d.offer.name || d.offer.product, price: d.offer.price, cur: offerCurrency(d.offer) };
      return out;
    });
    // Latest offers per page (from its newest snapshot).
    const offers = {};
    await Promise.all((pages || []).filter(p => p.extractor !== 'sitemap').map(async (p) => {
      const { data } = await s.from('web_snapshots').select('offers, taken_at').eq('page_id', p.id).order('taken_at', { ascending: false }).limit(1).maybeSingle();
      if (data) offers[p.id] = { list: data.offers || [], since: data.taken_at };
    }));
    return json(200, { ready: true, pages: pages || [], changes, offers });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  try {
    if (body.action === 'check') {
      const id = body.id ? Number(body.id) : null;
      // One page is quick; all of them can pass Netlify's ~10s request
      // limit, so that runs in the background and the page waits for it.
      if (id) return json(200, await runWebMonitor(s, { ids: [id], budgetMs: 8000 }));
      const at = new Date().toISOString();
      await startCompetitorsRefresh(event, 'web');
      return json(200, { started: true, at });
    }
    if (body.action === 'add') {
      let url;
      try { url = new URL(String(body.url || '').trim()); } catch { return json(400, { error: 'Enter a full link starting with https://' }); }
      if (!/^https?:$/.test(url.protocol)) return json(400, { error: 'Only http and https links' });
      const competitor = String(body.competitor || '').trim().slice(0, 60);
      if (!competitor) return json(400, { error: 'Say whose page this is' });
      const extractor = EXTRACTORS.includes(body.extractor) ? body.extractor : (/sitemap[^/]*\.xml$/i.test(url.pathname) ? 'sitemap' : 'text');
      const match = String(body.match || '').trim().slice(0, 200) || null;
      if (match) { try { new RegExp(match, 'i'); } catch { return json(400, { error: 'That filter isn\'t a valid pattern' }); } }
      const row = { competitor, label: String(body.label || '').trim().slice(0, 80) || null, url: url.href, extractor, match, sort: 90 };
      const { data: ex } = await s.from('web_pages').select('id').eq('url', url.href).maybeSingle();
      if (ex) { await s.from('web_pages').update({ active: true }).eq('id', ex.id); return json(200, { ok: true, id: ex.id, existed: true }); }
      const { data, error } = await s.from('web_pages').insert(row).select('id').single();
      if (error) throw error;
      // Read it once straight away, so it has a starting point.
      const r = await runWebMonitor(s, { ids: [data.id], budgetMs: 8000 });
      return json(200, { ok: true, id: data.id, check: r });
    }
    if (body.action === 'remove' || body.action === 'restore') {
      if (!body.id) return json(400, { error: 'id required' });
      const { error } = await s.from('web_pages').update({ active: body.action === 'restore' }).eq('id', body.id);
      if (error) throw error;
      return json(200, { ok: true });
    }
    return json(400, { error: 'unknown action' });
  } catch (e) { return json(500, { error: e.message }); }
}
