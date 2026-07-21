// Minimal RFC4180-style CSV parser — handles quoted fields, embedded commas,
// escaped quotes ("") and CRLF/LF line endings. Google Sheets' "Publish to
// web → CSV" export needs this (task cells routinely contain commas, e.g.
// "Mod 1: Lec 1, Case 4 & 5, Lec 2"), so a naive split(',') would break rows.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip — handled by the following \n
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

// "DD/MM/YYYY" -> "YYYY-MM-DD" (Postgres DATE literal). Returns null if malformed.
export function toIsoDate(ddmmyyyy) {
  const m = String(ddmmyyyy || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
