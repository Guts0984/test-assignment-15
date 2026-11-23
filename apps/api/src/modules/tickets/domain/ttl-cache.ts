/** Small time-bound cache that also shares one in-flight computation between identical concurrent requests. */
export type TtlCache<V> = { readonly get: (key: string, compute: () => Promise<V>) => Promise<V> };

export const createTtlCache = <V>(ttlMs: number, now: () => number, maxEntries = 200): TtlCache<V> => {
  const done = new Map<string, { at: number; value: V }>();
  const inflight = new Map<string, Promise<V>>();
  return {
    get: (key, compute) => {
      const hit = done.get(key);
      if (hit !== undefined && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
      const running = inflight.get(key);
      if (running !== undefined) return running;
      const p = compute()
        .then((value) => {
          if (done.size >= maxEntries) done.delete(done.keys().next().value as string);
          done.set(key, { at: now(), value });
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
};
