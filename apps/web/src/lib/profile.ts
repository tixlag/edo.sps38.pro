import type { MeResponseDto } from '@edo/api-client';

/**
 * Forward-compatible view of MeResponseDto: shortName/avatarUrl land in the
 * generated client after `pnpm api:generate` (NOT run in this change).
 * Access via optional reads so tsc stays green before AND after regen.
 */
type MeLike = MeResponseDto & {
  shortName?: string | null;
  avatarUrl?: string | null;
};

function asLike(profile?: MeResponseDto): MeLike | undefined {
  return profile as MeLike | undefined;
}

export function profileLabel(profile?: MeResponseDto): string {
  return profile?.fullName || (profile ? `Пользователь ЛК · ${profile.code1c ?? profile.uuid}` : 'Загрузка профиля…');
}

/** Compact signature: backend shortName («Фамилия И.О.») or «Фамилия И.» fallback. */
export function profileShortName(profile?: MeResponseDto): string {
  const like = asLike(profile);
  const backend = like?.shortName?.trim();
  if (backend) return backend;
  const parts = (profile?.fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return profile ? `Пользователь ЛК · ${profile.code1c ?? profile.uuid}` : 'Загрузка профиля…';
  }
  const [surname, ...rest] = parts as [string, ...string[]];
  if (rest.length === 0) return surname;
  return `${surname} ${Array.from(rest[0])[0]}.`;
}

/** Avatar URL enriched server-side by EDO GET /api/v1/me; null when unavailable. */
export function profileAvatar(profile?: MeResponseDto): string | null {
  const url = asLike(profile)?.avatarUrl?.trim();
  return url ? url : null;
}

export function profileInitials(profile?: MeResponseDto): string {
  const name = profile?.fullName?.trim();
  return name ? name.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase('ru') : '—';
}
