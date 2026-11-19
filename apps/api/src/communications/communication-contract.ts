import { z } from "zod";
import { ChatChannel } from "./communications.dto";

export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
export const CHAT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export const recipientSchema = z.object({
  id: z.string().min(1).max(256),
  channel: z.nativeEnum(ChatChannel),
  label: z.string().max(256),
  supportsFiles: z.boolean(),
});
export const erpContextSchema = z.object({
  recipients: z.array(recipientSchema).max(50),
  templates: z
    .array(
      z.object({
        id: z.string().max(64),
        title: z.string().max(256),
        text: z.string().max(16000),
      }),
    )
    .max(100),
});
export const attachmentSchema = z.object({
  id: z.string().max(512),
  filename: z.string().max(256),
  mimeType: z.string().max(128),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export const messageSchema = z.object({
  id: z.string().min(1).max(512),
  channel: z.nativeEnum(ChatChannel),
  outgoing: z.boolean(),
  author: z.string().max(512),
  createdAt: z.string().datetime({ offset: true }),
  text: z.string().max(65536),
  attachments: z.array(attachmentSchema).max(10),
});
export const erpHistorySchema = z.object({
  items: z.array(messageSchema).max(100),
  nextCursor: z.string().max(128).nullable(),
});
export const erpCandidateSchema = z.object({
  erpUid: z.string().uuid(),
  chatUuid: z.string().uuid().nullable(),
  fullName: z.string().max(512),
  projectCode: z.string().max(64).nullable(),
  projectName: z.string().max(512).nullable(),
  positionCode: z.string().max(64).nullable(),
  positionName: z.string().max(512).nullable(),
  deleted: z.boolean(),
  employed: z.boolean().nullish(),
  statusId: z.string().max(128).nullish(),
  statusName: z.string().max(256).nullish(),
  managerId: z.string().max(64).nullish(),
  managerName: z.string().max(512).nullish(),
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
      );
    })
    .nullish(),
  citizenship: z.string().max(2).nullish(),
  sex: z.string().max(16).nullish(),
  mentorName: z.string().max(512).nullish(),
});
export type ErpCandidate = z.infer<typeof erpCandidateSchema>;
export const erpCatalogSchema = z.object({
  items: z.array(erpCandidateSchema).max(100),
  nextCursor: z.string().max(128).nullable(),
});
export const erpSendResultSchema = z.object({
  status: z.enum(["SENT", "FAILED", "UNKNOWN"]),
  providerId: z.string().max(256).nullable(),
  errorCode: z.string().max(64).nullable(),
});

export function mergeMessages<T extends { id: string; createdAt: string }>(
  ...pages: T[][]
): T[] {
  const unique = new Map(pages.flat().map((item) => [item.id, item]));
  return [...unique.values()].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
