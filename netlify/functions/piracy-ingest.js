// Gmail auto-log for takedown notices (2026-11-13). A Google Apps Script in
// the support@taai.live mailbox (shown in /team > Piracy) POSTs every sent
// notice here: { key, messageId, subject, sentAt, body }. The Telegram links
// in it are added to the takedown log exactly like /team's "Add to log".
// Each email is logged once (piracy_ingested), so re-runs of the script
// don't count a notice twice.
import { getSupabase, json } from './lib/supabase.js';
import { parseNoticeText, addPiracyItems, piracyIngestKey } from './lib/piracy.js';

function istDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  if (!body.key || body.key !== piracyIngestKey(process.env.SUPABASE_SERVICE_KEY)) return json(401, { error: 'bad key' });
  const messageId = String(body.messageId || '').slice(0, 200);
  if (!messageId) return json(400, { error: 'messageId required' });
  const supabase = getSupabase();

  const { data: seen, error: seenErr } = await supabase.from('piracy_ingested').select('message_id').eq('message_id', messageId).maybeSingle();
  if (seenErr) return json(500, { error: seenErr.message });
  if (seen) return json(200, { ok: true, already: true });

  const subject = String(body.subject || '').slice(0, 300);
  const items = parseNoticeText(String(body.body || '').slice(0, 200000));
  const reportedOn = istDate(body.sentAt);
  const label = subject.replace(/^(re|fwd?):\s*/i, '').replace(/^Copyright and Trademark Infringement Notice\s*[–-]\s*/i, '').slice(0, 120) || 'Notice sent by email';
  let r = { added: 0, updated: 0 };
  if (items.length) {
    try { r = await addPiracyItems(supabase, { items, notice_label: label, reported_on: reportedOn }); }
    catch (e) { return json(500, { error: e.message }); }
  }
  const { error: insErr } = await supabase.from('piracy_ingested').insert({
    message_id: messageId, subject: subject || null, sent_on: reportedOn, links: items.length,
    added: r.added || 0, updated: r.updated || 0,
  });
  if (insErr && !/duplicate/i.test(insErr.message)) return json(500, { error: insErr.message });
  return json(200, { ok: true, links: items.length, added: r.added || 0, updated: r.updated || 0 });
}
