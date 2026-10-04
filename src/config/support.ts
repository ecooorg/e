/**
 * Crisis support contacts and distress markers — international defaults.
 * Owner may replace with local numbers for a specific region.
 * Prefer internationally recognized helplines; local emergency numbers vary by country.
 */

export const SUPPORT_CONTACTS: { label: string; value: string }[] = [
  { label: 'International Association for Suicide Prevention (IASP)', value: 'https://www.iasp.info/suicidalthoughts/' },
  { label: 'US & Canada: 988 Suicide & Crisis Lifeline', value: '988' },
  { label: 'US: Crisis Text Line', value: 'Text HOME to 741741' },
  { label: 'Emergency services (varies by country)', value: '911 / 112 / local emergency number' },
];

export const DISTRESS_MARKERS: string[] = [
  "don't want to live",
  'dont want to live',
  'kill myself',
  'suicide',
  'harm myself',
  'no reason to live',
  'end my life',
  'want to die',
  'no point in living',
  'self-harm',
  'self harm',
];

export function hasDistressMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return DISTRESS_MARKERS.some((m) => lower.includes(m));
}

/** Scan multiple free-text fields; returns first matching marker or null */
export function findDistressInTexts(texts: (string | undefined | null)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const lower = t.toLowerCase();
    for (const m of DISTRESS_MARKERS) {
      if (lower.includes(m)) return m;
    }
  }
  return null;
}
