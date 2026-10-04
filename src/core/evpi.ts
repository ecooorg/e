/** EVPI calculator — international copy */

export interface EvpiResult {
  evOpen: number;
  bestNoInfo: number;
  evPerfect: number;
  evpi: number;
}

export interface EvpiRange {
  min: number;
  max: number;
}

export function evpi(p: number, G: number, L: number): EvpiResult {
  const evOpen = p * G - (1 - p) * L;
  const bestNoInfo = Math.max(evOpen, 0);
  const evPerfect = p * G;
  return { evOpen, bestNoInfo, evPerfect, evpi: evPerfect - bestNoInfo };
}

export function evpiRange(
  p: number,
  G: number,
  L: number,
  d = 0.1
): EvpiRange {
  const lo = Math.max(0, p - d);
  const hi = Math.min(1, p + d);
  const pts = [lo, hi];
  const pStar = G + L > 0 ? L / (G + L) : 0.5;
  if (pStar > lo && pStar < hi) pts.push(pStar);
  const values = pts.map((x) => evpi(x, G, L).evpi);
  return { min: Math.min(...values), max: Math.max(...values) };
}

export type EvpiVerdict =
  | 'NOT_JUSTIFIED'
  | 'MAY_BE_JUSTIFIED'
  | 'DEPENDS';

export function evpiVerdict(
  testCost: number,
  range: EvpiRange
): { code: EvpiVerdict; text: string } {
  if (testCost > range.max) {
    return {
      code: 'NOT_JUSTIFIED',
      text: 'Test is not justified even with perfect information',
    };
  }
  if (testCost <= range.min) {
    return {
      code: 'MAY_BE_JUSTIFIED',
      text: 'Test may be justified; this is an upper bound — a real test yields less',
    };
  }
  return {
    code: 'DEPENDS',
    text: 'Depends on your probability assessment',
  };
}

export function validateEvpiInput(
  p: number,
  G: number,
  L: number,
  c: number
): string | null {
  if (p < 0 || p > 1) return 'p must be in range 0…1 (or 0…100%)';
  if (G < 0 || L < 0) return 'G and L ≥ 0';
  if (G + L <= 0) return 'G + L > 0';
  if (c < 0) return 'test cost ≥ 0';
  return null;
}
