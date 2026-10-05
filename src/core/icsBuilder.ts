/** .ics calendar file — TZ B.5 */

function escapeIcs(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line: string): string {
  // Fold at 75 octets without splitting UTF-8 multi-byte chars
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + (parts.length === 0 ? 75 : 74), bytes.length);
    // back up if mid multi-byte
    while (end > i && (bytes[end] & 0xc0) === 0x80) end--;
    const chunk = bytes.subarray(i, end).toString('utf8');
    parts.push(parts.length === 0 ? chunk : ' ' + chunk);
    i = end;
  }
  return parts.join('\r\n');
}

export interface IcsEvent {
  uid: string;
  date: string; // YYYY-MM-DD
  summary: string;
}

export function buildIcs(events: IcsEvent[], prodId = '-//Bifurcation Engine//v13//EN'): string {
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
  ];
  for (const e of events) {
    const ymd = e.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART;VALUE=DATE:${ymd}`);
    lines.push(foldLine(`SUMMARY:${escapeIcs(e.summary)}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
