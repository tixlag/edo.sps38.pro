-- AlterTable
ALTER TABLE `document_expiration_alerts`
    ADD COLUMN `status` VARCHAR(16) NULL,
    ADD COLUMN `attemptCount` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `nextAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `leaseExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `lastError` TEXT NULL,
    ADD COLUMN `broadcastUuid` VARCHAR(36) NULL,
    ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Existing rows represent notifications that were already sent before the
-- claim/retry ledger existed, so preserve them as complete.
UPDATE `document_expiration_alerts` SET `status` = 'SENT';

-- AlterTable
ALTER TABLE `document_expiration_alerts`
    MODIFY COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'CLAIMED',
    MODIFY COLUMN `sentAt` DATETIME(3) NULL;
