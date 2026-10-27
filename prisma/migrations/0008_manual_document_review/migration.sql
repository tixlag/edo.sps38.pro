-- AlterTable
ALTER TABLE `document_types` ADD COLUMN `allForeign` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `allRu` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `catalogSyncedAt` DATETIME(3) NULL,
    ADD COLUMN `erpUid` VARCHAR(36) NULL;

-- AlterTable
ALTER TABLE `document_versions` ADD COLUMN `approvalLeaseUntil` DATETIME(3) NULL,
    ADD COLUMN `approvedStorageKey` VARCHAR(1024) NULL,
    ADD COLUMN `citizenship` VARCHAR(2) NULL,
    ADD COLUMN `cleanupPending` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `pendingApprovalStorageKey` VARCHAR(1024) NULL,
    ADD COLUMN `positionCode1c` VARCHAR(64) NULL,
    ADD COLUMN `rejectionReason` VARCHAR(1024) NULL;

-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('EMPLOYEE_CREATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_UPLOAD_STARTED', 'DOCUMENT_UPLOAD_FAILED', 'DOCUMENT_OCR_COMPLETED', 'DOCUMENT_FIELDS_UPDATED', 'CANDIDATE_LINKED', 'DOCUMENT_RETURNED', 'DOCUMENT_APPROVED', 'DOCUMENT_ERP_SEND_REQUESTED', 'DOCUMENT_ERP_SEND_COMPLETED', 'DOCUMENT_SIGNED', 'WORKFLOW_STAGE_CHANGED', 'DATA_IMPORTED', 'LK_REFERENCE_SYNCED', 'LK_EVENT_APPLIED') NOT NULL;

-- AlterTable
ALTER TABLE `candidates` ADD COLUMN `identityKey` VARCHAR(80) NULL,
    MODIFY `chatUuid` VARCHAR(36) NULL;

-- AlterTable
ALTER TABLE `document_version_fields` ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'text',
    ADD COLUMN `ordinal` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `required` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `submittedValue` TEXT NULL;

-- CreateTable
CREATE TABLE `document_type_fields` (
    `id` VARCHAR(64) NOT NULL,
    `documentTypeId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `required` BOOLEAN NOT NULL,
    `ordinal` INTEGER NOT NULL,

    UNIQUE INDEX `document_type_fields_documentTypeId_name_key`(`documentTypeId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_type_positions` (
    `id` VARCHAR(64) NOT NULL,
    `documentTypeId` VARCHAR(64) NOT NULL,
    `code1c` VARCHAR(64) NOT NULL,

    UNIQUE INDEX `document_type_positions_documentTypeId_code1c_key`(`documentTypeId`, `code1c`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_submissions` (
    `id` VARCHAR(64) NOT NULL,
    `identityKey` VARCHAR(80) NOT NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `versionId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'UPLOADING',
    `leaseToken` VARCHAR(36) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `document_submissions_versionId_key`(`versionId`),
    INDEX `document_submissions_status_leaseUntil_idx`(`status`, `leaseUntil`),
    UNIQUE INDEX `document_submissions_identityKey_idempotencyKey_key`(`identityKey`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `erp_document_deliveries` (
    `id` VARCHAR(64) NOT NULL,
    `versionId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    `payload` JSON NOT NULL,
    `errorCode` VARCHAR(64) NULL,
    `leaseToken` VARCHAR(36) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `erp_document_deliveries_versionId_key`(`versionId`),
    INDEX `erp_document_deliveries_status_leaseUntil_idx`(`status`, `leaseUntil`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `erp_document_attempts` (
    `id` VARCHAR(64) NOT NULL,
    `deliveryId` VARCHAR(64) NOT NULL,
    `actorId` VARCHAR(64) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,

    INDEX `erp_document_attempts_deliveryId_idx`(`deliveryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_stream_grants` (
    `id` VARCHAR(64) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `chatUuid` VARCHAR(36) NULL,
    `code1c` VARCHAR(64) NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `document_stream_grants_tokenHash_key`(`tokenHash`),
    INDEX `document_stream_grants_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `document_types_erpUid_key` ON `document_types`(`erpUid`);

-- CreateIndex
UPDATE `candidates` SET `identityKey` = CONCAT('chat:', LOWER(`chatUuid`));
ALTER TABLE `candidates` MODIFY `identityKey` VARCHAR(80) NOT NULL;

CREATE UNIQUE INDEX `candidates_identityKey_key` ON `candidates`(`identityKey`);

-- AddForeignKey
ALTER TABLE `document_type_fields` ADD CONSTRAINT `document_type_fields_documentTypeId_fkey` FOREIGN KEY (`documentTypeId`) REFERENCES `document_types`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_type_positions` ADD CONSTRAINT `document_type_positions_documentTypeId_fkey` FOREIGN KEY (`documentTypeId`) REFERENCES `document_types`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_submissions` ADD CONSTRAINT `document_submissions_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `erp_document_deliveries` ADD CONSTRAINT `erp_document_deliveries_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `erp_document_attempts` ADD CONSTRAINT `erp_document_attempts_deliveryId_fkey` FOREIGN KEY (`deliveryId`) REFERENCES `erp_document_deliveries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE `document_submissions` MODIFY `idempotencyKey` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
