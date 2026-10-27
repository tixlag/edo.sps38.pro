/** Shared sidebar and direct-route capabilities. Key presence is authoritative. */
export function canAccessPath(
  permissions: object | undefined,
  pathname: string,
): boolean {
  const has = (...rules: number[]) =>
    !!permissions &&
    rules.some((rule) =>
      Object.prototype.hasOwnProperty.call(permissions, String(rule)),
    );
  const segment = "/" + (pathname.split("/")[1] ?? "");
  const required: Record<string, number[]> = {
    "/": [20000],
    "/review": [20002],
    "/review-ig": [20011],
    "/employees": [20001],
    "/onboarding": [20001],
    "/signing": [20003],
    "/settings": [20004],
    "/participants": [20004],
    "/history": [20002, 20011, 20005],
    "/my-reviews": [20002, 20011, 20005],
    "/annotation-settings": [20009],
  };
  const rules = required[segment];
  return !!rules && (has(20009) || has(...rules));
}
