import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { profileAvatar, profileInitials, profileLabel, profileShortName } from './profile';
import { AppHeader } from '../components/AppHeader';
import { AppSidebar } from '../components/AppSidebar';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Fictional profile only (no real personal data): «Иванов Иван Иванович».
function fictionalProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: '00000000-0000-0000-0000-000000000001',
    code1c: 'УП00040092',
    fullName: 'Иванов Иван Иванович',
    shortName: 'Иванов И.И.',
    avatarUrl: 'https://lk.example.com/photos/avatar-1.jpg',
    positionName: 'Позиция',
    departmentName: 'Отдел',
    organizationName: 'ООО «Пример»',
    permissions: { '20000': [] },
    locationScope: { all: false, locationIds: [98] },
    ...overrides,
  };
}

describe('profile helpers (compact signature + avatar)', () => {
  it('shortName prefers backend «Фамилия И.О.» with title=fullName preserved by callers', () => {
    expect(profileShortName(fictionalProfile() as never)).toBe('Иванов И.И.');
  });

  it('shortName falls back without backend value; label falls back to code1c', () => {
    expect(profileShortName(fictionalProfile({ shortName: null }) as never)).toBe('Иванов И.');
    expect(profileLabel(fictionalProfile({ fullName: null }) as never)).toContain('УП00040092');
    expect(profileLabel(undefined)).toContain('Загрузка');
  });

  it('avatarUrl trims; empty -> null', () => {
    expect(profileAvatar(fictionalProfile() as never)).toBe('https://lk.example.com/photos/avatar-1.jpg');
    expect(profileAvatar(fictionalProfile({ avatarUrl: '  ' }) as never)).toBeNull();
    expect(profileAvatar(fictionalProfile({ avatarUrl: null }) as never)).toBeNull();
  });

  it('initials from first two words', () => {
    expect(profileInitials(fictionalProfile() as never)).toBe('ИИ');
  });
});

describe('avatar onError fallback (broken img -> initials)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    try {
      act(() => {
        root?.unmount();
      });
    } catch {
      /* noop */
    }
    container?.remove();
    container = null;
    root = null;
  });

  function mount(node: React.ReactElement): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const el = container;
    void act(() => {
      root!.render(node);
    });
    return el;
  }

  it('AppHeader/AppSidebar sources hide the img on error (no leftover empty img)', () => {
    for (const f of ['../components/AppHeader.tsx', '../components/AppSidebar.tsx']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect(src).toMatch(/onError/);
      // Compact signature stays: shortName text + title={fullName}.
      expect(src).toMatch(/title=\{fullName\}|title=\{avatarTitle\}/);
    }
    const headerSrc = readFileSync(join(here, '../components/AppHeader.tsx'), 'utf8');
    expect(headerSrc).toMatch(/title=\{fullName\}>\{shortName\}/);
  });

  it('AppHeader shows initials after the avatar errors', () => {
    const el = mount(
      React.createElement(AppHeader, { crumb: 'Дашборд', profile: fictionalProfile() as never }),
    );
    const img = el.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://lk.example.com/photos/avatar-1.jpg');
    act(() => {
      img!.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('ИИ');
  });

  it('AppSidebar (expanded) shows initials after the avatar errors', () => {
    const el = mount(
      React.createElement(AppSidebar, {
        collapsed: false,
        active: '/',
        onToggle: () => undefined,
        onNavigate: () => undefined,
        profile: fictionalProfile() as never,
      }),
    );
    const img = el.querySelector('img');
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('ИИ');
  });

  it('AppSidebar (collapsed) shows initials after the avatar errors', () => {
    const el = mount(
      React.createElement(AppSidebar, {
        collapsed: true,
        active: '/',
        onToggle: () => undefined,
        onNavigate: () => undefined,
        profile: fictionalProfile() as never,
      }),
    );
    const img = el.querySelector('img');
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('ИИ');
  });
});
