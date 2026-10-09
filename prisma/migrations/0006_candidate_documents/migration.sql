-- AlterTable
ALTER TABLE `documents` ADD COLUMN `candidateId` VARCHAR(64) NULL,
    MODIFY `employeeId` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `document_versions` ADD COLUMN `approvedAt` DATETIME(3) NULL,
    ADD COLUMN `approvedBy` VARCHAR(64) NULL,
    ADD COLUMN `ocrSource` VARCHAR(16) NULL,
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `status` ENUM('DRAFT', 'UPLOADED', 'OCR_PENDING', 'OCR_FAILED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'SIGNED', 'EXPIRED') NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('EMPLOYEE_CREATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_UPLOAD_STARTED', 'DOCUMENT_OCR_COMPLETED', 'DOCUMENT_FIELDS_UPDATED', 'CANDIDATE_LINKED', 'DOCUMENT_RETURNED', 'DOCUMENT_APPROVED', 'DOCUMENT_SIGNED', 'WORKFLOW_STAGE_CHANGED', 'DATA_IMPORTED', 'LK_REFERENCE_SYNCED', 'LK_EVENT_APPLIED') NOT NULL;

-- CreateTable
CREATE TABLE `candidates` (
    `id` VARCHAR(64) NOT NULL,
    `chatUuid` VARCHAR(36) NOT NULL,
    `locationId` INTEGER NULL,
    `code1c` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `candidates_chatUuid_key`(`chatUuid`),
    INDEX `candidates_locationId_idx`(`locationId`),
    INDEX `candidates_code1c_idx`(`code1c`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_version_files` (
    `id` VARCHAR(64) NOT NULL,
    `versionId` VARCHAR(64) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `storageKey` VARCHAR(1024) NOT NULL,
    `filename` VARCHAR(255) NOT NULL,
    `mimeType` VARCHAR(128) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `sha256` VARCHAR(64) NULL,
    `pageCount` INTEGER NOT NULL DEFAULT 1,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `document_version_files_versionId_ordinal_key`(`versionId`, `ordinal`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_version_fields` (
    `id` VARCHAR(64) NOT NULL,
    `versionId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `originalValue` TEXT NULL,
    `value` TEXT NULL,
    `editedBy` VARCHAR(64) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `document_version_fields_versionId_name_key`(`versionId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ocr_jobs` (
    `id` VARCHAR(64) NOT NULL,
    `candidateId` VARCHAR(64) NOT NULL,
    `versionId` VARCHAR(64) NOT NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `status` ENUM('UPLOADING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'REJECTED', 'FAILED') NOT NULL DEFAULT 'UPLOADING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `leaseToken` VARCHAR(36) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `cleanupPending` BOOLEAN NOT NULL DEFAULT false,
    `correlationId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ocr_jobs_versionId_key`(`versionId`),
    INDEX `ocr_jobs_status_leaseUntil_idx`(`status`, `leaseUntil`),
    INDEX `ocr_jobs_cleanupPending_idx`(`cleanupPending`),
    UNIQUE INDEX `ocr_jobs_candidateId_idempotencyKey_key`(`candidateId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ocr_issues` (
    `id` VARCHAR(64) NOT NULL,
    `versionId` VARCHAR(64) NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `message` VARCHAR(1024) NOT NULL,
    `fileOrdinal` INTEGER NULL,
    `pageNumber` INTEGER NULL,

    INDEX `ocr_issues_versionId_idx`(`versionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ocr_outbox` (
    `id` VARCHAR(64) NOT NULL,
    `jobId` VARCHAR(64) NOT NULL,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publishedAt` DATETIME(3) NULL,
    `leaseToken` VARCHAR(36) NULL,
    `leaseUntil` DATETIME(3) NULL,

    UNIQUE INDEX `ocr_outbox_jobId_key`(`jobId`),
    INDEX `ocr_outbox_availableAt_publishedAt_idx`(`availableAt`, `publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `documents_candidateId_documentTypeId_key` ON `documents`(`candidateId`, `documentTypeId`);

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `documents_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `document_version_files` ADD CONSTRAINT `document_version_files_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_version_fields` ADD CONSTRAINT `document_version_fields_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ocr_jobs` ADD CONSTRAINT `ocr_jobs_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ocr_jobs` ADD CONSTRAINT `ocr_jobs_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ocr_issues` ADD CONSTRAINT `ocr_issues_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ocr_outbox` ADD CONSTRAINT `ocr_outbox_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `ocr_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- MariaDB forbids CHECK on ON UPDATE CASCADE foreign keys; owner IDs are immutable.
ALTER TABLE `documents` DROP FOREIGN KEY `documents_employeeId_fkey`;
ALTER TABLE `documents` ADD CONSTRAINT `documents_employeeId_fkey`
  FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Existing documents retain their employee owner; candidate ownership is exclusive.
ALTER TABLE `documents` ADD CONSTRAINT `documents_one_owner`
  CHECK ((`employeeId` IS NOT NULL AND `candidateId` IS NULL)
      OR (`employeeId` IS NULL AND `candidateId` IS NOT NULL));

-- Preserve existing version status and expose each legacy original through the new file API.
UPDATE `document_versions` AS v
  JOIN `documents` AS d ON d.id = v.documentId
  SET v.status = d.status;
INSERT INTO `document_version_files` (`id`, `versionId`, `ordinal`, `storageKey`, `filename`, `mimeType`, `sizeBytes`, `pageCount`)
SELECT UUID(), id, 0, storageKey, LEFT(SUBSTRING_INDEX(storageKey, '/', -1), 255),
       COALESCE(mimeType, 'application/octet-stream'), COALESCE(sizeBytes, 0), 1
FROM `document_versions` WHERE storageKey <> '';

-- Idempotency keys and OCR field names are case-sensitive identifiers.
ALTER TABLE `ocr_jobs` MODIFY `idempotencyKey` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
ALTER TABLE `document_version_fields` MODIFY `name` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
