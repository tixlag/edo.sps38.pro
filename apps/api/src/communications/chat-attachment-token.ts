import { createHmac, timingSafeEqual } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const locatorSchema = z.object({
  candidateId: z.string().max(64),
  source: z.enum(["lk", "erp"]),
  chatUuid: z.string().uuid().optional(),
  id: z.string().max(1024),
  filename: z.string().max(256),
  mimeType: z.string().max(128),
});
export type AttachmentLocator = z.infer<typeof locatorSchema>;
export function signAttachment(
  secret: string,
  locator: AttachmentLocator,
): string {
  const payload = Buffer.from(JSON.stringify(locator)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyAttachment(
  secret: string,
  token: string,
  candidateId: string,
): AttachmentLocator {
  try {
    if (token.length > 2500) throw new Error();
    const [payload, mac, extra] = token.split(".");
    const expected = createHmac("sha256", secret).update(payload).digest();
    const actual = Buffer.from(mac, "base64url");
    if (
      extra ||
      expected.length !== actual.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new Error();
    const locator = locatorSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    if (locator.candidateId !== candidateId) throw new Error();
    if (locator.source === "lk" && !locator.chatUuid) throw new Error();
    return locator;
  } catch {
    throw new BadRequestException("CHAT_ATTACHMENT_INVALID");
  }
}
