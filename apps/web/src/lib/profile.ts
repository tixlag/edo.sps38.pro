import type { MeResponseDto } from '@edo/api-client';

export function profileLabel(profile?: MeResponseDto): string {
  return profile?.fullName || (profile ? `Пользователь ЛК · ${profile.code1c ?? profile.uuid}` : 'Загрузка профиля…');
}

export function profileInitials(profile?: MeResponseDto): string {
  const name = profile?.fullName?.trim();
  return name ? name.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase('ru') : '—';
}
