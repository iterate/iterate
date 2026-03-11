type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type CacheStore = Map<string, CacheEntry<unknown>>;

declare global {
  var __iterateSimpleKvStores: Map<string, CacheStore> | undefined;
}

function getStores(): Map<string, CacheStore> {
  globalThis.__iterateSimpleKvStores ??= new Map();
  return globalThis.__iterateSimpleKvStores;
}

function getStore(namespace: string): CacheStore {
  const stores = getStores();
  let store = stores.get(namespace);
  if (!store) {
    store = new Map();
    stores.set(namespace, store);
  }
  return store;
}

export function createSimpleKv<T>(namespace: string) {
  const store = getStore(namespace);

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value as T;
    },
    set(key: string, value: T, ttlMs: number) {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    },
    delete(key: string) {
      store.delete(key);
    },
  };
}
