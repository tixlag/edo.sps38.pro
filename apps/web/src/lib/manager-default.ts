export function findCurrentUserAsManager<T extends { id: string; name: string }>(
  managers: T[] | undefined,
  me: { fullName?: string | null; uuid?: string } | undefined,
): T | undefined {
  if (!managers || !me?.fullName) return undefined;
  const target = me.fullName.trim().toLowerCase().replace(/\s+/g, " ");
  return managers.find(
    (m) =>
      m.name.trim().toLowerCase().replace(/\s+/g, " ") === target ||
      (me.uuid && m.id.toLowerCase() === me.uuid.toLowerCase()),
  );
}
