/** Pure, reversible scroll state. No elapsed time drives the fee journey. */
export const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
export const ramp = (n: number, from: number, to: number) => {
  const t = clamp((n - from) / (to - from));
  return t * t * (3 - 2 * t);
};
export function feeJourney(progress: number) {
  const p = clamp(progress);
  return {
    incoming: 0.25 + 0.75 * ramp(p, 0, 0.36),
    orb: 1 - ramp(p, 0.33, 0.4),
    coreImpact: ramp(p, 0.31, 0.38) * (1 - ramp(p, 0.43, 0.52)),
    processing: ramp(p, 0.27, 0.39) * (1 - ramp(p, 0.58, 0.72)),
    division: ramp(p, 0.39, 0.47),
    outgoing: ramp(p, 0.44, 0.66),
    arrival: ramp(p, 0.64, 0.73),
    exit: ramp(p, 0.84, 1),
    push: ramp(p, 0, 0.34) * (1 - ramp(p, 0.56, 0.76)),
  };
}
