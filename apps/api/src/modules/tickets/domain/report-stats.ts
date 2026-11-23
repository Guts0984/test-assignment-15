/** Percentile with linear interpolation (the same definition as SQL percentile_cont) over an unsorted array. */
export const percentileCont = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const v = Float64Array.from(values).sort();
  const pos = p * (v.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = v[lo] as number;
  const b = v[hi] as number;
  return a + (b - a) * (pos - lo);
};

export type Bucket = {
  tickets: number;
  fr: number[];
  res: number[];
  decided: number;
  within: number;
  breaches: number;
  ratingSum: number;
  ratingCount: number;
  dist: [number, number, number, number, number];
};

export const emptyBucket = (): Bucket => ({ tickets: 0, fr: [], res: [], decided: 0, within: 0, breaches: 0, ratingSum: 0, ratingCount: 0, dist: [0, 0, 0, 0, 0] });

export const addBucket = (into: Bucket, b: Bucket): void => {
  into.tickets += b.tickets;
  for (const x of b.fr) into.fr.push(x);
  for (const x of b.res) into.res.push(x);
  into.decided += b.decided;
  into.within += b.within;
  into.breaches += b.breaches;
  into.ratingSum += b.ratingSum;
  into.ratingCount += b.ratingCount;
  for (let i = 0; i < 5; i += 1) into.dist[i] = (into.dist[i] ?? 0) + (b.dist[i] ?? 0);
};

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

/** Turns collected values into the numbers shown in the report. */
export const toStats = (b: Bucket) => ({
  tickets: b.tickets,
  firstResponseMedianMinutes: percentileCont(b.fr, 0.5),
  firstResponseP90Minutes: percentileCont(b.fr, 0.9),
  resolutionMedianMinutes: percentileCont(b.res, 0.5),
  resolutionP90Minutes: percentileCont(b.res, 0.9),
  withinSlaPercent: b.decided === 0 ? null : round((b.within / b.decided) * 100, 1),
  breaches: b.breaches,
  ratingAverage: b.ratingCount === 0 ? null : round(b.ratingSum / b.ratingCount, 2),
  ratingCount: b.ratingCount,
});
