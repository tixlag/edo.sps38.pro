import { z } from "zod";
import type { RedisService } from "../redis/redis.module";

export const REVIEW_CHANGE_CHANNEL = "edo:review:changes:v1";
export const reviewChangeSchema = z.object({
  items: z
    .array(
      z
        .object({
          group: z.enum(["RU", "IG"]).optional(),
          candidateId: z.string().min(1).max(64).optional(),
          documentId: z.string().min(1).max(64).optional(),
        })
        .refine(
          (item) => !!(item.group || item.candidateId || item.documentId),
        ),
    )
    .min(1)
    .max(50),
});
export type ReviewChangeItem = z.infer<
  typeof reviewChangeSchema
>["items"][number];

export async function publishReviewChanges(
  redis: RedisService,
  items: ReviewChangeItem[],
) {
  if (!items.length) return true;
  return (
    (await redis.publish(REVIEW_CHANGE_CHANNEL, JSON.stringify({ items }))) !==
    null
  );
}
