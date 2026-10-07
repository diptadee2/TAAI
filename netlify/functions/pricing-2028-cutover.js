// Scheduled function (see netlify.toml): runs every 15 minutes and, once
// the GATE 2028 Full Course's super early bird offer has ended (end of
// 2026-10-20 IST), raises its price from 9999 to 11999, changes the % off
// pill from 33 to 20 (11999 against the 15000 MRP), and clears the offer's
// deadline. Direct request 2026-10-07: "after october 20th the
// price will go to 11999".
//
// The update is guarded on the row still holding exactly the offer's
// values (price 9999, deadline 2026-10-20), so it runs once and never
// overwrites a change someone makes in /team before or after it. Once
// it has run (or /team has changed either value) every later tick is a
// single cheap read. Safe to delete this function and its netlify.toml
// entry after Oct 21.
import { getSupabase, json } from './lib/supabase.js';

const CUTOVER_AT = new Date('2026-10-21T00:00:00+05:30').getTime();
const ID = 'full-course-2028';
const OFFER_PRICE = 9999;
const NEW_PRICE = 11999;
const NEW_DISCOUNT = '20'; // 11999 vs the 15000 MRP = 20% off
const OFFER_DEADLINE = '2026-10-20';

export const handler = async () => {
  if (Date.now() < CUTOVER_AT) {
    return json(200, { ok: true, skipped: 'before cutover', cutoverAt: new Date(CUTOVER_AT).toISOString() });
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('site_pricing')
    .update({ price: NEW_PRICE, discount: NEW_DISCOUNT, discount_deadline: null })
    .eq('id', ID)
    .eq('price', OFFER_PRICE)
    .eq('discount_deadline', OFFER_DEADLINE)
    .select('id, price, discount, discount_deadline');
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true, updated: data.length > 0, row: data[0] || null });
};
