// GET  /api/challenge-register -> { open, cutoff }
// POST /api/challenge-register { full_name, email, phone, gate_enrollment_id, dob, upi_id, agree }
//
// Public, unauthenticated: the "100 pe 100% off" registration form on the
// courses page. Insert-only by design. There is no update path, so once
// submitted the details are locked (a student can't swap in someone else's
// GATE identity after the results). A genuine mistake is fixed by the team
// deleting the row in /team, then the student submits again.
import { getSupabase, json } from './lib/supabase.js';
import { fetchChallengeCutoff, isChallengeOpen } from './lib/challenge.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v) { return typeof v === 'string' ? v.normalize('NFKC').trim() : ''; }

function validate(body) {
  const fullName = clean(body.full_name).replace(/\s+/g, ' ');
  const email = clean(body.email).toLowerCase();
  let phone = clean(body.phone).replace(/[\s\-()+]/g, '');
  const enrollment = clean(body.gate_enrollment_id).toUpperCase().replace(/\s+/g, '');
  const dob = clean(body.dob);
  const upi = clean(body.upi_id).replace(/\s+/g, '');

  if (fullName.length < 2 || fullName.length > 100) return { error: 'Enter your full name exactly as on your GATE application.' };
  if (!EMAIL_RE.test(email) || email.length > 200) return { error: 'Enter a valid email address.' };
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (!/^[6-9]\d{9}$/.test(phone)) return { error: 'Enter a valid 10-digit Indian mobile number.' };
  if (!/^[A-Z0-9]{5,20}$/.test(enrollment)) return { error: 'Enter your GATE enrollment ID (letters and numbers only).' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return { error: 'Enter your date of birth.' };
  const year = Number(dob.slice(0, 4));
  const d = new Date(dob + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || year < 1950 || year > 2012) return { error: 'Enter your date of birth as on your GATE application.' };
  // UPI IDs look like name@bank (handle 2-256 chars, provider letters/digits).
  if (!/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9]{2,64}$/.test(upi)) return { error: 'Enter a valid UPI ID, like yourname@okaxis.' };
  if (body.agree !== true) return { error: 'Please accept the challenge terms.' };
  return { row: { full_name: fullName, email, phone, gate_enrollment_id: enrollment, dob, upi_id: upi } };
}

export async function handler(event) {
  const supabase = getSupabase();
  const cutoff = await fetchChallengeCutoff(supabase);
  const open = isChallengeOpen(cutoff);

  if (event.httpMethod === 'GET') return json(200, { open, cutoff });
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
  // Honeypot: real people never see or fill this field.
  if (clean(body.website)) return json(200, { ok: true });
  if (!open) return json(403, { error: 'Registration for the challenge has closed.', closed: true, cutoff });

  const v = validate(body);
  if (v.error) return json(400, { error: v.error });

  const headers = event.headers || {};
  const row = {
    ...v.row,
    ip: headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || null,
    user_agent: (headers['user-agent'] || '').slice(0, 300) || null,
  };
  const { error } = await supabase.from('challenge_registrations').insert(row);
  if (error) {
    if (error.code === '23505') {
      const which = /enrollment/.test(error.message || '') ? 'This GATE enrollment ID' : 'This email';
      return json(409, { error: which + ' is already registered for the challenge. Registrations can\'t be changed; email support@taai.live if something is wrong.' });
    }
    if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204' || /does not exist|Could not find the/.test(error.message || '')) {
      return json(503, { error: 'Registration isn\'t available just yet. Please try again later.' });
    }
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
  return json(200, { ok: true });
}
