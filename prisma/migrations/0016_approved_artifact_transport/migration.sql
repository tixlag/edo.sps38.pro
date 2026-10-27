-- Additive only: historical approved objects are PDF and deliveries stay v1.
ALTER TABLE `document_versions`
  ADD COLUMN `approvedMimeType` VARCHAR(128) NULL,
  ADD COLUMN `approvedFilename` VARCHAR(255) NULL,
  ADD COLUMN `approvedExtension` VARCHAR(8) NULL,
  ADD COLUMN `approvedSizeBytes` INTEGER NULL,
  ADD COLUMN `approvedSha256` VARCHAR(64) NULL,
  ADD COLUMN `approvedPageCount` INTEGER NULL,
  ADD COLUMN `approvedPreparation` VARCHAR(32) NULL;
ALTER TABLE `erp_document_deliveries`
  ADD COLUMN `transport` VARCHAR(16) NOT NULL DEFAULT 'base64-v1',
  ADD COLUMN `attemptCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `nextAttemptAt` DATETIME(3) NULL;
CREATE INDEX `erp_document_deliveries_status_nextAttemptAt_idx`
  ON `erp_document_deliveries` (`status`, `nextAttemptAt`);
