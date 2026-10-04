/** Number validation: only numbers present in user input (or derived) are allowed in model output.
 *  Word-numerals are not locale-specific; English and common digit forms are primary.
 */

const EN_NUM: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', twohundred: '200',
};

export function extractNums(s: string): string[] {
  return [...s.matchAll(/(?<![\p{L}_])[-+]?\d+(?:[.,]\d+)?%/gu)].map((m) => m[0]);
}

export function expandWordNumerals(text: string): string[] {
  const lower = text.toLowerCase().replace(/[\s-]/g, '');
  const out: string[] = [];
  for (const [w, d] of Object.entries(EN_NUM)) {
    if (lower.includes(w)) out.push(d);
  }
  return out;
}

export function collectAllowedFromInput(input: string): Set<string> {
  const allowed = new Set<string>([
    ...extractNums(input),
    ...expandWordNumerals(input),
  ]);
  for (let h = 12; h <= 24; h++) allowed.add(String(h));
  for (let i = 0; i <= 31; i++) allowed.add(String(i));
  for (const n of [45, 60, 90, 100, 120, 150, 180, 200, 365]) allowed.add(String(n));
  return allowed;
}

export function validateNumbers(out: string, input: string, derived: string[] = []): string[] {
  const allowed = collectAllowedFromInput(input);
  for (const d of derived) allowed.add(d);

  const idLike = new Set<string>();
  for (const m of out.matchAll(/\b(?:obj|hyp|n|exp|c|id)[-_]?(\d+)\b/gi)) {
    idLike.add(m[1]);
  }

  return extractNums(out).filter((n) => {
    if (allowed.has(n)) return false;
    if (n.endsWith('%') && allowed.has(n.slice(0, -1))) return false;
    const bare = n.replace('%', '');
    if (idLike.has(bare)) return false;
    return true;
  });
}
