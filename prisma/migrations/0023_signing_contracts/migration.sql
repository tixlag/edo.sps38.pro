-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('EMPLOYEE_CREATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_UPLOAD_STARTED', 'DOCUMENT_UPLOAD_FAILED', 'DOCUMENT_OCR_COMPLETED', 'DOCUMENT_FIELDS_UPDATED', 'CANDIDATE_LINKED', 'DOCUMENT_RETURNED', 'DOCUMENT_APPROVED', 'DOCUMENT_ERP_SEND_REQUESTED', 'DOCUMENT_ERP_SEND_COMPLETED', 'DOCUMENT_SIGNED', 'WORKFLOW_STAGE_CHANGED', 'DATA_IMPORTED', 'LK_REFERENCE_SYNCED', 'LK_EVENT_APPLIED', 'DOCUMENT_OCR_RETRIED', 'DOCUMENT_OCR_REQUESTED', 'ANNOTATION_CATALOG_CHANGED', 'ANNOTATION_PREFERENCE_CHANGED', 'ANNOTATION_CLAIMED', 'ANNOTATION_SAVED', 'ANNOTATION_SUBMITTED', 'ANNOTATION_ACCEPTED', 'ANNOTATION_CHANGES_REQUESTED', 'ANNOTATION_REASSIGNED', 'CONTRACT_CREATED', 'CONTRACT_FILE_REPLACED', 'CONTRACT_SENT', 'CONTRACT_CONFIRMED', 'CONTRACT_DECLINED', 'CONTRACT_PREPARATION_FAILED') NOT NULL;

-- CreateTable
CREATE TABLE `signing_contracts` (
    `id` VARCHAR(64) NOT NULL,
    `candidateId` VARCHAR(64) NOT NULL,
    `requestKey` VARCHAR(128) NOT NULL,
    `documentType` VARCHAR(128) NOT NULL,
    `documentTypeName` VARCHAR(512) NOT NULL,
    `fullName` VARCHAR(512) NULL,
    `birthDate` DATE NULL,
    `recipientCode1c` VARCHAR(64) NULL,
    `createdBy` VARCHAR(64) NOT NULL,
    `sentBy` VARCHAR(64) NULL,
    `status` ENUM('PREPARING', 'DRAFT', 'WAITING_EMPLOYEE', 'COMPLETED', 'DECLINED', 'FAILED') NOT NULL DEFAULT 'PREPARING',
    `revision` INTEGER NOT NULL DEFAULT 0,
    `currentVersion` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` VARCHAR(512) NULL,
    `journalKey` VARCHAR(1024) NULL,
    `declineRequestKey` VARCHAR(128) NULL,
    `sentAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `signing_contracts_requestKey_key`(`requestKey`),
    UNIQUE INDEX `signing_contracts_declineRequestKey_key`(`declineRequestKey`),
    INDEX `signing_contracts_candidateId_createdAt_idx`(`candidateId`, `createdAt`),
    INDEX `signing_contracts_recipientCode1c_status_idx`(`recipientCode1c`, `status`),
    INDEX `signing_contracts_sentBy_status_idx`(`sentBy`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `signing_contract_versions` (
    `id` VARCHAR(64) NOT NULL,
    `contractId` VARCHAR(64) NOT NULL,
    `version` INTEGER NOT NULL,
    `requestKey` VARCHAR(128) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `originalKey` VARCHAR(1024) NULL,
    `originalFilename` VARCHAR(255) NULL,
    `filename` VARCHAR(255) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `signing_contract_versions_requestKey_key`(`requestKey`),
    UNIQUE INDEX `signing_contract_versions_storageKey_key`(`storageKey`),
    UNIQUE INDEX `signing_contract_versions_contractId_version_key`(`contractId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `signing_contract_confirmations` (
    `id` VARCHAR(64) NOT NULL,
    `contractId` VARCHAR(64) NOT NULL,
    `version` INTEGER NOT NULL,
    `role` VARCHAR(16) NOT NULL,
    `actorId` VARCHAR(64) NOT NULL,
    `actorLabel` VARCHAR(512) NOT NULL,
    `mode` VARCHAR(16) NOT NULL DEFAULT 'demo',
    `bank` VARCHAR(16) NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `requestKey` VARCHAR(128) NOT NULL,
    `confirmedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `signing_contract_confirmations_requestKey_key`(`requestKey`),
    UNIQUE INDEX `signing_contract_confirmations_contractId_role_key`(`contractId`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `signing_contract_notifications` (
    `id` VARCHAR(64) NOT NULL,
    `contractId` VARCHAR(64) NOT NULL,
    `recipientId` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `message` VARCHAR(512) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `readAt` DATETIME(3) NULL,

    INDEX `signing_contract_notifications_recipientId_createdAt_idx`(`recipientId`, `createdAt`),
    UNIQUE INDEX `signing_contract_notifications_contractId_kind_key`(`contractId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `signing_contract_objects` (
    `key` VARCHAR(512) NOT NULL,
    `retained` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `signing_contract_objects_retained_createdAt_idx`(`retained`, `createdAt`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `signing_contracts` ADD CONSTRAINT `signing_contracts_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `signing_contract_versions` ADD CONSTRAINT `signing_contract_versions_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `signing_contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `signing_contract_confirmations` ADD CONSTRAINT `signing_contract_confirmations_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `signing_contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `signing_contract_notifications` ADD CONSTRAINT `signing_contract_notifications_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `signing_contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

