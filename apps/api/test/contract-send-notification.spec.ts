import { describe, expect, it, vi } from "vitest";
import { ContractsService } from "../src/contracts/contracts.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const actor = { uuid: "hr", code1c: null, accessRules: { "20003": [], "20008": [] } } as AuthPrincipal;

function setup() {
  const notice = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: vi.fn(),
    candidate: { findFirst: vi.fn().mockResolvedValue({ code1c: "EMP-1" }) },
    signingContract: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    signingContractConfirmation: { create: vi.fn().mockResolvedValue({}) },
    signingContractNotification: { create: notice },
  };
  const prisma = {
    signingContract: { findFirst: vi.fn().mockResolvedValue({
      id: "contract-1", candidateId: "candidate-1", status: "DRAFT", revision: 2,
      currentVersion: 1, confirmations: [], versions: [{ version: 1, sha256: "hash" }],
    }) },
    signingContractConfirmation: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const audit = { logInTransaction: vi.fn().mockResolvedValue({}) };
  const delivery = { wake: vi.fn() };
  const service = new ContractsService(prisma as never, audit as never, {} as never, {} as never, {} as never, {} as never, delivery as never);
  vi.spyOn(service, "detail").mockResolvedValue({} as never);
  return { service, prisma, tx, notice, audit, delivery };
}

describe("notification when sending a contract", () => {
  it("writes the invitation for the frozen employee code inside the sending transaction", async () => {
    const { service, prisma, tx, notice, audit, delivery } = setup();
    await service.send("contract-1", { revision: 2, requestId: "request-1" }, actor);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.signingContract.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "WAITING_EMPLOYEE", recipientCode1c: "EMP-1" }),
    }));
    expect(notice).toHaveBeenCalledWith({ data: expect.objectContaining({
      contractId: "contract-1", kind: "sent", recipientId: "EMP-1",
    }) });
    expect(audit.logInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({ action: "CONTRACT_SENT" }));
    expect(delivery.wake).toHaveBeenCalledWith("contract-1");
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(delivery.wake.mock.invocationCallOrder[0]);
  });

  it("propagates a notification write failure instead of completing the send", async () => {
    const { service, notice, audit, delivery } = setup();
    notice.mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(service.send("contract-1", { revision: 2, requestId: "request-1" }, actor)).rejects.toThrow("notification unavailable");
    expect(audit.logInTransaction).not.toHaveBeenCalled();
    expect(delivery.wake).not.toHaveBeenCalled();
  });

  it("waits until the transaction commits before waking delivery", async () => {
    const { service, prisma, delivery } = setup();
    const transaction = prisma.$transaction.getMockImplementation()!;
    let finishCommit!: () => void;
    const commit = new Promise<void>((resolve) => { finishCommit = resolve; });
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      const result = await transaction(callback);
      await commit;
      return result;
    });
    const sending = service.send("contract-1", { revision: 2, requestId: "request-1" }, actor);
    await vi.waitFor(() => expect(prisma.$transaction).toHaveBeenCalledOnce());
    expect(delivery.wake).not.toHaveBeenCalled();
    finishCommit();
    await sending;
    expect(delivery.wake).toHaveBeenCalledWith("contract-1");
  });

  it("does not create a second invitation when the same request is replayed", async () => {
    const { service, prisma, notice } = setup();
    prisma.signingContract.findFirst.mockResolvedValueOnce({
      id: "contract-1", candidateId: "candidate-1", status: "WAITING_EMPLOYEE", revision: 3,
      currentVersion: 1, versions: [{ version: 1, sha256: "hash" }],
      confirmations: [{ role: "employer", requestKey: "hr:request-1", actorId: "hr" }],
    });
    await service.send("contract-1", { revision: 2, requestId: "request-1" }, actor);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });
});
