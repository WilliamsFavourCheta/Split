/** Pure, reversible scroll state. No elapsed time drives the fee journey. */
export const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
export const ramp = (n: number, from: number, to: number) => {
  const t = clamp((n - from) / (to - from));
  return t * t * (3 - 2 * t);
};
export function feeJourney(progress: number) {
  const p = clamp(progress);
  return {
    incoming: 0.25 + 0.75 * ramp(p, 0, 0.4),
    orb: 1 - ramp(p, 0.34, 0.43),
    processing: ramp(p, 0.2, 0.4) * (1 - ramp(p, 0.55, 0.75)),
    division: ramp(p, 0.4, 0.6),
    outgoing: ramp(p, 0.55, 0.8),
    arrival: ramp(p, 0.74, 0.82),
    exit: ramp(p, 0.82, 1),
    push: ramp(p, 0, 0.35) * (1 - ramp(p, 0.55, 0.8)),
  };
}
