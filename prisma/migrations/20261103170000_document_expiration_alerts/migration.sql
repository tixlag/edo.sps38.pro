-- AlterTable
ALTER TABLE `documents` ADD COLUMN `expiresAt` DATE NULL;
CREATE INDEX `documents_expiresAt_idx` ON `documents`(`expiresAt`);

-- AlterTable
ALTER TABLE `document_versions` ADD COLUMN `expiresAt` DATE NULL;
CREATE INDEX `document_versions_expiresAt_idx` ON `document_versions`(`expiresAt`);

-- AlterTable
CREATE INDEX `candidate_previous_documents_expiresAt_idx` ON `candidate_previous_documents`(`expiresAt`);

-- CreateTable
CREATE TABLE `document_expiration_alerts` (
    `id` VARCHAR(64) NOT NULL,
    `documentId` VARCHAR(64) NULL,
    `previousDocId` VARCHAR(64) NULL,
    `candidateId` VARCHAR(64) NULL,
    `employeeId` VARCHAR(64) NULL,
    `documentTitle` VARCHAR(255) NOT NULL,
    `expiresAt` DATE NOT NULL,
    `thresholdDays` INTEGER NOT NULL,
    `recipientCode1c` VARCHAR(64) NOT NULL,
    `recipientRole` VARCHAR(32) NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `document_expiration_alerts_expiresAt_idx`(`expiresAt`),
    INDEX `document_expiration_alerts_thresholdDays_idx`(`thresholdDays`),
    UNIQUE INDEX `uniq_doc_alert`(`documentId`, `thresholdDays`, `recipientCode1c`),
    UNIQUE INDEX `uniq_prevdoc_alert`(`previousDocId`, `thresholdDays`, `recipientCode1c`),
    PRIMARY KEY (`id`),
    CONSTRAINT `document_expiration_alerts_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `document_expiration_alerts_previousDocId_fkey` FOREIGN KEY (`previousDocId`) REFERENCES `candidate_previous_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
