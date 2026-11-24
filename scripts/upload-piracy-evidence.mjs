// Uploads a folder of piracy evidence screenshots to the PRIVATE Supabase
// storage bucket "piracy-evidence" (2026-11-24), for possible legal action.
// /team > Piracy > Evidence shows them (admin only, links that expire).
//
//   node --env-file=.env scripts/upload-piracy-evidence.mjs <folder> [--dry]
//
// The folder is laid out like ~/Downloads/TAAI_Evidence:
//   <NN_Network>/<YYYY-MM-DD>_<target>_<n>.png   one subfolder per operator network
//   00_INDEX.csv   File,Date,Network,Target,Link(s),What it shows   (optional)
//   any *.pdf at the top level is uploaded too (e.g. the combined evidence PDF)
//
// Files are uploaded byte for byte (never re-encoded) and never overwritten:
// a path that already exists is skipped, so evidence stays as first captured.
// manifest.json in the bucket lists every file with its SHA-256 fingerprint,
// size, capture date, network, target, links and description; new uploads are
// merged into it. The fingerprint lets anyone show later that a file hasn't
// been changed since it was stored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSupabase } from '../netlify/functions/lib/supabase.js';

const BUCKET = 'piracy-evidence';
const dir = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!dir || !fs.existsSync(dir)) { console.error('usage: upload-piracy-evidence.mjs <folder> [--dry]'); process.exit(1); }

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.csv': 'text/csv' };

function parseCsvLine(l) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}
const index = {};
const idxFile = path.join(dir, '00_INDEX.csv');
if (fs.existsSync(idxFile)) {
  for (const l of fs.readFileSync(idxFile, 'utf8').trim().split(/\r?\n/).slice(1)) {
    const [file, date, network, target, links, what] = parseCsvLine(l);
    index[file.trim()] = { date, network, target, links, what };
  }
}

function walk(d, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(d, e.name), r));
    else if (TYPES[path.extname(e.name).toLowerCase()]) out.push(r);
  }
  return out;
}

const s = getSupabase();
const { data: buckets } = await s.storage.listBuckets();
if (!(buckets || []).some(b => b.name === BUCKET)) {
  if (DRY) console.log('would create private bucket', BUCKET);
  else {
    const { error } = await s.storage.createBucket(BUCKET, { public: false });
    if (error) throw error;
    console.log('created private bucket', BUCKET);
  }
}

let manifest = { files: [] };
{
  const { data } = await s.storage.from(BUCKET).download('manifest.json');
  if (data) manifest = JSON.parse(await data.text());
}
const have = new Map(manifest.files.map(f => [f.path, f]));

let added = 0, skipped = 0;
for (const rel of walk(dir)) {
  const buf = fs.readFileSync(path.join(dir, rel));
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (have.has(rel)) {
    if (have.get(rel).sha256 !== sha256) console.warn('DIFFERENT from stored copy, not replaced:', rel);
    skipped++; continue;
  }
  const meta = index[rel] || {};
  const m = path.basename(rel).match(/^(\d{4}-\d{2}-\d{2})_/);
  const entry = {
    path: rel,
    sha256,
    bytes: buf.length,
    type: TYPES[path.extname(rel).toLowerCase()],
    captured_on: meta.date || (m && m[1]) || null,
    network: meta.network || (rel.includes('/') ? rel.split('/')[0].replace(/^\d+_/, '') : null),
    target: meta.target || null,
    links: meta.links || null,
    what: meta.what || null,
    uploaded_at: new Date().toISOString(),
  };
  if (DRY) { console.log('would upload', rel, sha256.slice(0, 12)); added++; continue; }
  const { error } = await s.storage.from(BUCKET).upload(rel, buf, { contentType: entry.type, upsert: false });
  if (error && !/exists|Duplicate/i.test(error.message)) throw new Error(rel + ': ' + error.message);
  manifest.files.push(entry);
  added++;
  if (added % 20 === 0) console.log(added, 'uploaded');
}

if (!DRY) {
  manifest.updated_at = new Date().toISOString();
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  const { error } = await s.storage.from(BUCKET).upload('manifest.json', JSON.stringify(manifest, null, 1), { contentType: 'application/json', upsert: true });
  if (error) throw error;
}
console.log(DRY ? 'dry run:' : 'done:', added, 'new,', skipped, 'already stored; manifest has', manifest.files.length + (DRY ? added : 0), 'files');
