/** Fires `n` calls at the same moment and waits for all of them. */
export const burst = <T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
