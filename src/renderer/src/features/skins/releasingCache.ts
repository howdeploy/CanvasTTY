/**
 * A reference-counted cache of asynchronously loaded values. The last release keeps an entry for `delayMs` (a card
 * that remounts reuses it), then disposes it. Every removal checks it removes its own entry: a failed load or a late
 * release timer never evicts a newer entry loaded under the same key.
 */
export interface ReleasingCacheTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface Entry<V> {
  references: number;
  value: Promise<V>;
  loaded?: V;
  expired?: boolean;
  releaseTimer?: unknown;
}

export function createReleasingCache<K, V>(options: {
  load(key: K): Promise<V>;
  dispose(value: V): void;
  delayMs: number;
  timers?: ReleasingCacheTimers;
}): { acquire(key: K): { value: Promise<V>; release(): void }; size(): number } {
  const timers: ReleasingCacheTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
  };
  const entries = new Map<K, Entry<V>>();
  const remove = (key: K, entry: Entry<V>): void => {
    if (entries.get(key) === entry) entries.delete(key);
  };
  return {
    acquire(key) {
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry<V> = { references: 0, value: Promise.resolve(undefined as V) };
        created.value = options.load(key).then((value) => {
          if (created.expired) options.dispose(value);
          else created.loaded = value;
          return value;
        }, (error: unknown) => {
          remove(key, created);
          throw error;
        });
        created.value.catch(() => undefined);
        entries.set(key, created);
        entry = created;
      }
      const own = entry;
      if (own.releaseTimer !== undefined) timers.clearTimeout(own.releaseTimer);
      own.releaseTimer = undefined;
      own.references += 1;
      let released = false;
      return {
        value: own.value,
        release() {
          if (released) return;
          released = true;
          if (--own.references > 0) return;
          own.releaseTimer = timers.setTimeout(() => {
            own.releaseTimer = undefined;
            if (own.references > 0) return;
            remove(key, own);
            own.expired = true;
            if (own.loaded !== undefined) options.dispose(own.loaded);
          }, options.delayMs);
        }
      };
    },
    size: () => entries.size
  };
}
