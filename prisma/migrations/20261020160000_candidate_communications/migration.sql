-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('EMPLOYEE_CREATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_UPLOAD_STARTED', 'DOCUMENT_UPLOAD_FAILED', 'DOCUMENT_OCR_COMPLETED', 'DOCUMENT_FIELDS_UPDATED', 'CANDIDATE_LINKED', 'DOCUMENT_RETURNED', 'DOCUMENT_APPROVED', 'DOCUMENT_ERP_SEND_REQUESTED', 'DOCUMENT_ERP_SEND_COMPLETED', 'DOCUMENT_SIGNED', 'WORKFLOW_STAGE_CHANGED', 'DATA_IMPORTED', 'LK_REFERENCE_SYNCED', 'LK_EVENT_APPLIED', 'COMMUNICATION_REQUESTED', 'COMMUNICATION_COMPLETED', 'DOCUMENT_OCR_RETRIED', 'DOCUMENT_OCR_REQUESTED') NOT NULL;

-- AlterTable
ALTER TABLE `candidates` ADD COLUMN `catalogSyncedAt` DATETIME(3) NULL,
    ADD COLUMN `erpDeleted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `erpUid` VARCHAR(36) NULL;

-- CreateTable
CREATE TABLE `communication_operations` (
    `id` VARCHAR(36) NOT NULL,
    `candidateId` VARCHAR(64) NOT NULL,
    `actorId` VARCHAR(64) NOT NULL,
    `actorCode1c` VARCHAR(64) NOT NULL,
    `requestKey` VARCHAR(128) NOT NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `recipientId` VARCHAR(256) NOT NULL,
    `text` TEXT NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `providerId` VARCHAR(256) NULL,
    `errorCode` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `communication_operations_candidateId_createdAt_idx`(`candidateId`, `createdAt`),
    UNIQUE INDEX `communication_operations_actorId_requestKey_key`(`actorId`, `requestKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `communication_attachments` (
    `id` VARCHAR(36) NOT NULL,
    `candidateId` VARCHAR(64) NOT NULL,
    `actorId` VARCHAR(64) NOT NULL,
    `filename` VARCHAR(256) NOT NULL,
    `mimeType` VARCHAR(128) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `operationId` VARCHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `communication_attachments_storageKey_key`(`storageKey`),
    INDEX `communication_attachments_candidateId_actorId_idx`(`candidateId`, `actorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `candidates_erpUid_key` ON `candidates`(`erpUid`);

-- AddForeignKey
ALTER TABLE `communication_operations` ADD CONSTRAINT `communication_operations_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `communication_attachments` ADD CONSTRAINT `communication_attachments_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `communication_attachments` ADD CONSTRAINT `communication_attachments_operationId_fkey` FOREIGN KEY (`operationId`) REFERENCES `communication_operations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

