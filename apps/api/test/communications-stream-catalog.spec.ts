import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { NotFoundException } from "@nestjs/common";
import { CommunicationEventsService } from "../src/communications/communication-events.service";
import { CandidateCatalogService } from "../src/communications/candidate-catalog.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const principal: AuthPrincipal = {
  uuid: "reader",
  code1c: null,
  accessRules: { "20000": [], "20007": ["98"] },
  sid: null,
  deviceId: null,
  expiresAt: new Date(Date.now() + 60000),
};
const erpUid = "463b4dfc-5b53-4dbd-a774-9460fae562e3";
afterEach(() => vi.useRealTimers());
function eventSetup() {
  const values = new Map<string, string>();
  const redis = {
    setNxPxStrict: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return true;
    }),
    getStrict: vi.fn(async (key: string) => values.get(key) ?? null),
  };
  const access = { candidate: vi.fn(async () => ({ erpUid, chatUuid: null })) };
  const close = vi.fn();
  const lk = { configured: () => true, watch: vi.fn(() => close) };
  const events = new CommunicationEventsService(
    redis as never,
    access as never,
    lk as never,
    new ConfigService({ EDO_PUBLIC_API_URL: "https://edo/api" }),
  );
  return { events, redis, access, lk, close };
}
describe("candidate scoped SSE grants", () => {
  it("stores hashed grants, bounds lifetime by the JWT, rechecks scope and cleans up on unsubscribe", async () => {
    const s = eventSetup();
    const grant = await s.events.grant("c1", principal);
    expect(Date.parse(grant.expiresAt)).toBe(principal.expiresAt!.getTime());
    expect(s.redis.setNxPxStrict.mock.calls[0][0]).not.toContain(grant.token);
    const stream = await s.events.open(`Bearer ${grant.token}`);
    const notifications: unknown[] = [];
    const subscription = stream.subscribe((message) =>
      notifications.push(message),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(s.access.candidate).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ uuid: principal.uuid }),
    );
    expect(notifications).toContainEqual({ type: "changed", data: {} });
    subscription.unsubscribe();
    s.events.onModuleDestroy();
  });
  it("denies expired, malformed and missing grants", async () => {
    const s = eventSetup();
    await expect(s.events.open("Bearer invalid")).rejects.toThrow();
    await expect(s.events.open(`Bearer ${"0".repeat(64)}`)).rejects.toThrow();
    await expect(
      s.events.grant("c1", {
        ...principal,
        expiresAt: new Date(Date.now() - 1),
      }),
    ).rejects.toThrow();
  });
  it("stops the stream when the candidate leaves the reader’s location scope", async () => {
    vi.useFakeTimers();
    const s = eventSetup();
    const grant = await s.events.grant("c1", principal);
    const stream = await s.events.open(`Bearer ${grant.token}`);
    const complete = vi.fn();
    stream.subscribe({ complete });
    await vi.advanceTimersByTimeAsync(1);
    s.access.candidate.mockRejectedValue(new NotFoundException());
    await vi.advanceTimersByTimeAsync(5000);
    expect(complete).toHaveBeenCalledTimes(1);
    s.events.onModuleDestroy();
  });
});

function catalogSetup() {
  const candidate = {
    findMany: vi.fn(async () => []),
    create: vi.fn(async ({ data }: { data: object }) => ({
      ...data,
      id: "new-candidate",
    })),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: object }) => ({
        ...data,
        id: where.id,
      }),
    ),
  };
  const prisma = {
    candidate,
    $queryRaw: vi.fn(),
    lkLocation: {
      findUnique: vi.fn(async () => ({ locationId: 98, deleted: false })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
      fn(prisma),
    ),
  };
  const redis = {
    setNxPxStrict: vi.fn(async () => true),
    compareAndExpire: vi.fn(async () => true),
    compareAndDelStrict: vi.fn(async () => true),
    set: vi.fn(),
    get: vi.fn(),
    getStrict: vi.fn(async () => null),
    evalStrict: vi.fn(async () => 1),
  };
  const erp = {
    configured: () => true,
    catalog: vi.fn(async () => ({
      items: [] as Record<string, unknown>[],
      nextCursor: null as string | null,
    })),
  };
  const audit = { logInTransaction: vi.fn() };
  const access = {
    candidateWhere: vi.fn(() => ({ locationId: { in: [98] } })),
  };
  const service = new CandidateCatalogService(
    prisma as never,
    redis as never,
    erp as never,
    audit as never,
    access as never,
    new ConfigService(),
  );
  return { service, prisma, redis, erp, audit, access };
}
const catalogRow = {
  erpUid,
  chatUuid: null,
  fullName: "Новый кандидат",
  projectCode: "PROJECT",
  projectName: "Объект",
  positionCode: null,
  positionName: null,
  deleted: false,
};
describe("ERP candidate catalog projection", () => {
  it("imports candidates without documents or chats, maps the exact project code and audits atomically", async () => {
    const s = catalogSetup();
    s.erp.catalog.mockResolvedValue({ items: [catalogRow], nextCursor: null });
    await s.service.sync();
    expect(s.prisma.candidate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        erpUid,
        identityKey: `erp-candidate:${erpUid}`,
        chatUuid: null,
      }),
    });
    expect(s.audit.logInTransaction).toHaveBeenCalledTimes(1);
    expect(s.redis.set).toHaveBeenCalledTimes(1);
  });
  it("does not match people by name and refuses conflicting ERP/chat identities", async () => {
    const s = catalogSetup();
    s.erp.catalog.mockResolvedValue({
      items: [{ ...catalogRow, chatUuid: erpUid }],
      nextCursor: null,
    });
    s.prisma.candidate.findMany.mockResolvedValue([
      { id: "a" },
      { id: "b" },
    ] as never[]);
    await s.service.sync();
    expect(s.prisma.candidate.create).not.toHaveBeenCalled();
    expect(s.prisma.candidate.update).not.toHaveBeenCalled();
  });
  it("retains existing records on an empty or failed snapshot and releases coordination", async () => {
    const s = catalogSetup();
    await s.service.sync();
    expect(s.prisma.candidate.update).not.toHaveBeenCalled();
    s.erp.catalog.mockRejectedValueOnce(new Error("source unavailable"));
    await expect(s.service.sync()).rejects.toThrow("source unavailable");
    expect(s.redis.compareAndDelStrict).toHaveBeenCalledTimes(2);
  });
  it("fails closed when coordination is lost and detects repeated cursors", async () => {
    const s = catalogSetup();
    s.erp.catalog.mockResolvedValue({
      items: [catalogRow],
      nextCursor: "repeat",
    });
    s.redis.compareAndExpire.mockResolvedValueOnce(false);
    await expect(s.service.sync()).rejects.toThrow("LOCK_LOST");
    expect(s.prisma.candidate.create).not.toHaveBeenCalled();
    s.redis.compareAndExpire.mockResolvedValue(true);
    await expect(s.service.sync()).rejects.toThrow("CURSOR_STALLED");
  });
  it("uses the location scope in the catalog DB query even without review document filters", async () => {
    const s = catalogSetup();
    await s.service.list(principal, { q: "Новый", limit: 50 });
    expect(s.prisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { locationId: { in: [98] } },
            { erpDeleted: false },
            { fullName: { contains: "Новый" } },
          ]),
        },
      }),
    );
  });
});
