-- Fencing singleton for snapshot-vs-event serialization (see ADR-002).
-- Every LK-projection write runs in a short transaction that first takes
-- SELECT ... FOR UPDATE on this row and verifies permission:
-- events require activeRunId IS NULL (or a stale heartbeat = orphan);
-- snapshot page/mark writes require activeRunId = own runId AND matching
-- generation. No long transaction spans HTTP pagination.
CREATE TABLE IF NOT EXISTS `lk_sync_state` (
  `id` INT NOT NULL DEFAULT 1,
  `activeRunId` VARCHAR(64) NULL,
  `generation` BIGINT NOT NULL DEFAULT 0,
  `heartbeatAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `lk_sync_state` (`id`, `activeRunId`, `generation`, `heartbeatAt`)
VALUES (1, NULL, 0, NULL)
ON DUPLICATE KEY UPDATE `id` = `id`;
