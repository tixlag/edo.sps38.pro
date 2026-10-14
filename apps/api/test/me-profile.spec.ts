import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeController } from '../src/me/me.controller';
import { MeService, extractAvatarUrl, extractLkFullName, toShortName } from '../src/me/me.service';

// ---------------------------------------------------------------------------
// Depersonalized fixture for LK GET /api/auth/me. Shape mirrors the real
// response (top-level uuid/code_1c/login/accessRules/personalData/
// employeeData/metrics/jsonData/photos/phones/emails/primaryEmail/
// accessCards/licenseCheck/licenseTime) but EVERY value is fictional:
// fio «Иванов Иван Иванович», fake host lk.example.com, fake UNC \\SDOS.
// No real personal data is committed here.
// ---------------------------------------------------------------------------
const LK_BASE = 'https://lk.example.com';

function lkMeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: '00000000-0000-0000-0000-000000000001',
    code_1c: 'УП00040092',
    login: 'demo.user',
    accessRules: [{ rule: 'lk-internal-flag', scope: ['all'] }],
    personalData: {
      fio: 'Иванов Иван Иванович',
      passportId: '0000 000000',
      birthday: '1990-01-01',
      country: 'Россия',
      citizenship: 'РФ',
      status: 'active',
    },
    employeeData: {
      hireDate: '2020-01-01',
      lastWorkDate: null,
      organization: 'ООО «Пример»',
      aup: false,
      isContractor: false,
      fired: false,
      lastObject: { code_1c: '98', name: 'Объект № 98' },
      currentPosition: {
        positionCode1c: 'POS-1',
        positionName: 'Должность из ЛК (не источник EDO)',
        departmentCode1c: 'DEP-1',
        departmentName: 'Подраздел из ЛК (не источник EDO)',
        divisionCode1c: 'DIV-1',
        divisionName: 'Дивизион Пример',
      },
      lastPosition: {
        positionCode1c: 'POS-0',
        positionName: 'Бывшая должность',
        departmentCode1c: 'DEP-0',
        departmentName: 'Бывший отдел',
        divisionCode1c: 'DIV-0',
        divisionName: 'Бывший дивизион',
      },
      responsiblePersons: [],
      lateness: [],
    },
    metrics: {},
    jsonData: {},
    photos: {
      photoUrl: `${LK_BASE}/photos/avatar-1.jpg`,
      avatarUrl: `${LK_BASE}/photos/avatar-1.jpg`,
      photo1cUrl: '\\\\SDOS\\photos\\avatar-1.jpg',
    },
    phones: [],
    emails: [],
    primaryEmail: null,
    accessCards: [],
    licenseCheck: null,
    licenseTime: null,
    ...overrides,
  };
}

const PRINCIPAL = {
  uuid: '00000000-0000-0000-0000-000000000001',
  code1c: 'УП00040092',
  sid: null,
  deviceId: null,
  accessRules: { '20000': [], '20007': ['98', '148'] },
  expiresAt: null,
};

function svcWith(prismaEmployee: unknown, lkBase = LK_BASE) {
  return new MeService(
    { lkEmployee: prismaEmployee } as never,
    { get: (key: string) => (key === 'LK_BASE_URL' ? lkBase : undefined) } as never,
  );
}

function mockFetchJson(body: unknown, ok = true, status = 200) {
  const calls: Array<{ url: unknown; init: unknown }> = [];
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url, init });
    return { ok, status, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', impl);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractAvatarUrl (strict LK photos contract)', () => {
  it('absolute photos.avatarUrl wins (priority 1)', () => {
    const body = lkMeFixture({
      photos: {
        avatarUrl: `${LK_BASE}/photos/a.jpg`,
        photoUrl: `${LK_BASE}/photos/b.jpg`,
        photo1cUrl: '\\\\SDOS\\photos\\x.jpg',
      },
    });
    expect(extractAvatarUrl(body, LK_BASE)).toBe(`${LK_BASE}/photos/a.jpg`);
  });

  it('site-relative photos.avatarUrl resolves against LK_BASE_URL', () => {
    const body = lkMeFixture({ photos: { avatarUrl: '/photos/a.jpg', photoUrl: null, photo1cUrl: null } });
    expect(extractAvatarUrl(body, 'https://lk.example.com')).toBe('https://lk.example.com/photos/a.jpg');
  });

  it('falls back to photos.photoUrl when avatarUrl is missing (priority 2)', () => {
    const body = lkMeFixture({
      photos: { avatarUrl: null, photoUrl: `${LK_BASE}/photos/only-photo.jpg`, photo1cUrl: '\\\\SDOS\\x.jpg' },
    });
    expect(extractAvatarUrl(body, LK_BASE)).toBe(`${LK_BASE}/photos/only-photo.jpg`);
  });

  it('falls back to photoUrl when avatarUrl is UNC garbage; photo1cUrl UNC is never used', () => {
    const body = lkMeFixture({
      photos: {
        avatarUrl: '\\\\SDOS\\photos\\avatar-1.jpg',
        photoUrl: `${LK_BASE}/photos/ok.jpg`,
        photo1cUrl: '\\\\SDOS\\photos\\avatar-1.jpg',
      },
    });
    expect(extractAvatarUrl(body, LK_BASE)).toBe(`${LK_BASE}/photos/ok.jpg`);
  });

  it('UNC-only (incl. photo1cUrl) resolves to null', () => {
    const body = lkMeFixture({
      photos: { avatarUrl: null, photoUrl: null, photo1cUrl: '\\\\SDOS\\photos\\avatar-1.jpg' },
    });
    expect(extractAvatarUrl(body, LK_BASE)).toBeNull();
    const uncBoth = lkMeFixture({
      photos: { avatarUrl: '\\\\SDOS\\a.jpg', photoUrl: 'C:\\photos\\b.jpg', photo1cUrl: '\\\\SDOS\\c.jpg' },
    });
    expect(extractAvatarUrl(uncBoth, LK_BASE)).toBeNull();
  });

  it('empty / garbage / non-strings / protocol-relative / overlong -> null', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, [], 'ftp://x/y.jpg', '//evil.example.com/x.jpg', 'not a url', '\\server\\x', '/has\\backslash.jpg']) {
      const body = lkMeFixture({ photos: { avatarUrl: bad, photoUrl: bad, photo1cUrl: '\\\\SDOS\\x.jpg' } });
      expect(extractAvatarUrl(body, LK_BASE)).toBeNull();
    }
    const overlong = `https://lk.example.com/${'a'.repeat(2048)}`;
    expect(overlong.length).toBeGreaterThan(2048);
    expect(
      extractAvatarUrl(lkMeFixture({ photos: { avatarUrl: overlong, photoUrl: overlong } }), LK_BASE),
    ).toBeNull();
  });

  it('missing photos object -> null', () => {
    expect(extractAvatarUrl(lkMeFixture({ photos: null }), LK_BASE)).toBeNull();
    expect(extractAvatarUrl({ personalData: { fio: 'Иванов Иван Иванович' } }, LK_BASE)).toBeNull();
    expect(extractAvatarUrl(null, LK_BASE)).toBeNull();
  });
});

describe('extractLkFullName (personalData.fio fallback only)', () => {
  it('returns trimmed fio', () => {
    expect(extractLkFullName(lkMeFixture())).toBe('Иванов Иван Иванович');
  });
  it('empty / missing / non-string -> null', () => {
    expect(extractLkFullName(lkMeFixture({ personalData: { fio: '' } }))).toBeNull();
    expect(extractLkFullName(lkMeFixture({ personalData: {} }))).toBeNull();
    expect(extractLkFullName(lkMeFixture({ personalData: null }))).toBeNull();
    expect(extractLkFullName(null)).toBeNull();
  });
});

describe('MeService.get (projection first, LK fail-open)', () => {
  const projection = {
    code1c: 'УП00040092',
    uuid: '00000000-0000-0000-0000-000000000001',
    fullName: 'Петров Пётр Петрович',
    positionName: 'Позиция из проекции',
    departmentName: 'Отдел из проекции',
    organizationName: 'ООО «Проекция»',
  };

  it('projection fullName wins over LK fio; JWT permissions kept; LK position ignored', async () => {
    const svc = svcWith({
      findUnique: async () => projection,
      findMany: async () => [],
    });
    mockFetchJson(lkMeFixture());
    const me = await svc.get(PRINCIPAL as never, 'user-token');
    expect(me.fullName).toBe('Петров Пётр Петрович');
    expect(me.shortName).toBe(toShortName('Петров Пётр Петрович'));
    expect(me.positionName).toBe('Позиция из проекции');
    expect(me.departmentName).toBe('Отдел из проекции');
    // JWT is the only permissions source: LK accessRules shape must not leak in.
    expect(me.permissions).toEqual({ '20000': [], '20007': ['98', '148'] });
    expect(me.avatarUrl).toBe(`${LK_BASE}/photos/avatar-1.jpg`);
  });

  it('no projection -> fallback personalData.fio from LK (fail-open)', async () => {
    const svc = svcWith({ findUnique: async () => null, findMany: async () => [] });
    mockFetchJson(lkMeFixture());
    const me = await svc.get(PRINCIPAL as never, 'user-token');
    expect(me.fullName).toBe('Иванов Иван Иванович');
    expect(me.shortName).toBe('Иванов И.И.');
  });

  it('LK unreachable -> avatar null + fio null, but me still works from projection/JWT', async () => {
    const svc = svcWith({
      findUnique: async () => projection,
      findMany: async () => [],
    });
    vi.stubGlobal('fetch', (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch);
    const me = await svc.get(PRINCIPAL as never, 'user-token');
    expect(me.avatarUrl).toBeNull();
    expect(me.fullName).toBe('Петров Пётр Петрович');
    expect(me.permissions).toEqual(PRINCIPAL.accessRules);
  });

  it('LK redirect (302 / redirect:error rejection) -> null avatar, me works', async () => {
    const svc = svcWith({
      findUnique: async () => projection,
      findMany: async () => [],
    });
    // Undici with redirect:'error' rejects on 302; either shape must fail open.
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed: redirect mode is "error"');
    }) as unknown as typeof fetch);
    const me = await svc.get(PRINCIPAL as never, 'user-token');
    expect(me.avatarUrl).toBeNull();
    expect(me.fullName).toBe('Петров Пётр Петрович');
  });

  it('non-200 LK response -> null avatar', async () => {
    const svc = svcWith({ findUnique: async () => projection, findMany: async () => [] });
    mockFetchJson({ error: 'x' }, false, 500);
    expect((await svc.get(PRINCIPAL as never, 'user-token')).avatarUrl).toBeNull();
  });

  it('forwards user bearer token with 3s timeout + redirect:error, never the S2S token', async () => {
    const svc = svcWith({ findUnique: async () => projection, findMany: async () => [] });
    const calls = mockFetchJson(lkMeFixture());
    await svc.get(PRINCIPAL as never, 'user-token-abc');
    expect(calls).toHaveLength(1);
    const init = calls[0]!.init as { headers: Record<string, string>; redirect: string; signal: AbortSignal };
    expect(String(calls[0]!.url)).toContain('/api/auth/me');
    expect(init.headers.Authorization).toBe('Bearer user-token-abc');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('dev-demo-token and missing token never call LK', async () => {
    const svc = svcWith({ findUnique: async () => projection, findMany: async () => [] });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    expect((await svc.get(PRINCIPAL as never, 'dev-demo-token')).avatarUrl).toBeNull();
    expect((await svc.get(PRINCIPAL as never, undefined)).avatarUrl).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MeController (no OpenAPI header leak, @Req token path)', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('OpenAPI getMe has no required header param: no @Headers(authorization) in signature', () => {
    const src = readFileSync(join(here, '..', 'src', 'me', 'me.controller.ts'), 'utf8');
    expect(src).not.toMatch(/@Headers\(\s*['"]authorization['"]/);
    expect(src).toMatch(/@Req\(\)/);
  });

  it('forwards Bearer token from FastifyRequest headers; raw header never stored', async () => {
    let seen: string | undefined;
    const ctrl = new MeController({ get: (async (_p: unknown, t: unknown) => {
      seen = t as string | undefined;
      return { ok: true };
    }) as never } as never);
    const req = { headers: { authorization: 'Bearer tok-123' } };
    await ctrl.getMe({ uuid: 'u' } as never, req as never);
    expect(seen).toBe('tok-123');
  });

  it('missing / non-Bearer / array headers -> undefined token', async () => {
    const seen: Array<string | undefined> = [];
    const ctrl = new MeController({ get: (async (_p: unknown, t: unknown) => {
      seen.push(t as string | undefined);
      return { ok: true };
    }) as never } as never);
    await ctrl.getMe({ uuid: 'u' } as never, { headers: {} } as never);
    await ctrl.getMe({ uuid: 'u' } as never, { headers: { authorization: 'Basic abc' } } as never);
    await ctrl.getMe({ uuid: 'u' } as never, { headers: { authorization: ['Bearer array-tok'] } } as never);
    expect(seen).toEqual([undefined, undefined, 'array-tok']);
  });
});
