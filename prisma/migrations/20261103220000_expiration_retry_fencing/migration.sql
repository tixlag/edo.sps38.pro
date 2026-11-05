ALTER TABLE `document_expiration_alerts`
  ADD COLUMN `leaseToken` VARCHAR(36) NULL,
  ADD INDEX `document_expiration_alerts_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
  ADD INDEX `document_expiration_alerts_status_leaseExpiresAt_idx` (`status`, `leaseExpiresAt`);
