/** Brier score — international copy */

export function brierScore(forecasts: { p: number; outcome: 0 | 1 }[]): {
  score: number;
  n: number;
  warning?: string;
} {
  if (forecasts.length === 0) {
    return { score: NaN, n: 0, warning: 'No forecasts yet' };
  }
  const sum = forecasts.reduce((acc, f) => {
    const err = f.p - f.outcome;
    return acc + err * err;
  }, 0);
  const score = sum / forecasts.length;
  const warning =
    forecasts.length < 10
      ? `Small sample (n=${forecasts.length}); meaningful calibration needs dozens of forecasts`
      : undefined;
  return { score, n: forecasts.length, warning };
}
