ALTER TABLE `candidate_previous_documents` ADD COLUMN `sourceFingerprint` CHAR(64) NULL, ADD COLUMN `verificationCheckedAt` DATETIME(3) NULL;
ALTER TABLE `ig_arrival_sync_state` ADD COLUMN `lastScanCompletedAt` DATETIME(3) NULL, ADD COLUMN `lastScanHadErrors` BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE `ig_enrichment_jobs` (
 `candidateId` VARCHAR(64) NOT NULL,
 `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
 `priority` BOOLEAN NOT NULL DEFAULT false,
 `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 `attempts` INTEGER NOT NULL DEFAULT 0,
 `leaseToken` CHAR(36) NULL,
 `leaseExpiresAt` DATETIME(3) NULL,
 PRIMARY KEY (`candidateId`),
 INDEX `ig_enrichment_jobs_priority_status_nextAttemptAt_idx` (`priority`, `status`, `nextAttemptAt`),
 CONSTRAINT `ig_enrichment_jobs_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `ig_enrichment_lanes` (
 `id` VARCHAR(16) NOT NULL,
 `leaseToken` CHAR(36) NULL,
 `leaseExpiresAt` DATETIME(3) NULL,
 PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO `ig_enrichment_lanes` (`id`) VALUES ('background'), ('priority');
