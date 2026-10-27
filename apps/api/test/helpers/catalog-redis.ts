/** Explicit cache/lease test double: never uses the shared development Redis. */
export function createCatalogRedisDouble() {
  const entries = new Map<string, { value: string; until: number }>();
  const getStrict = async (key: string): Promise<string | null> => {
    const entry = entries.get(key);
    if (!entry || entry.until <= Date.now()) return null;
    return entry.value;
  };
  return {
    getStrict,
    async setNxPxStrict(key: string, value: string, ttl: number) {
      const existing = entries.get(key);
      if (existing && existing.until > Date.now()) return false;
      entries.set(key, { value, until: Date.now() + ttl });
      return true;
    },
    async compareAndDelStrict(key: string, value: string) {
      if ((await getStrict(key)) !== value) return false;
      return entries.delete(key);
    },
  };
}
