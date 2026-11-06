ALTER TABLE `signing_contract_notifications`
  ADD COLUMN `deliveredAt` DATETIME(3) NULL,
  ADD COLUMN `lkBroadcastUuid` VARCHAR(36) NULL,
  ADD COLUMN `lkReadSyncedAt` DATETIME(3) NULL,
  ADD COLUMN `deliveryLeaseToken` VARCHAR(36) NULL,
  ADD COLUMN `deliveryLeaseUntil` DATETIME(3) NULL,
  ADD COLUMN `deliveryRetryAt` DATETIME(3) NULL,
  ADD COLUMN `deliveryAttempts` INTEGER NOT NULL DEFAULT 0;

CREATE INDEX `signing_contract_notifications_deliveredAt_deliveryRetryAt_idx`
  ON `signing_contract_notifications` (`deliveredAt`, `deliveryRetryAt`);
