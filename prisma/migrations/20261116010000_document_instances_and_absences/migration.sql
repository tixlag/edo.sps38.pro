ALTER TABLE `document_types`
  ADD COLUMN `multipleInstancesAllowed` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `documents_candidateId_documentTypeId_idx` ON `documents` (`candidateId`, `documentTypeId`);
DROP INDEX `documents_candidateId_documentTypeId_key` ON `documents`;

CREATE TABLE `candidate_document_absences` (
  `id` VARCHAR(64) NOT NULL,
  `candidateId` VARCHAR(64) NOT NULL,
  `documentTypeId` VARCHAR(64) NOT NULL,
  `reason` TEXT NOT NULL,
  `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  `requestedBy` VARCHAR(64) NOT NULL,
  `decidedBy` VARCHAR(64) NULL,
  `decisionComment` TEXT NULL,
  `decidedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `candidate_document_absences_candidateId_documentTypeId_key` (`candidateId`, `documentTypeId`),
  INDEX `candidate_document_absences_status_idx` (`status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `candidate_document_absences_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `candidate_document_absences_documentTypeId_fkey` FOREIGN KEY (`documentTypeId`) REFERENCES `document_types` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `audit_logs` MODIFY `action` ENUM('EMPLOYEE_CREATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_UPLOAD_STARTED', 'DOCUMENT_UPLOAD_FAILED', 'DOCUMENT_OCR_COMPLETED', 'DOCUMENT_FIELDS_UPDATED', 'CANDIDATE_LINKED', 'DOCUMENT_RETURNED', 'DOCUMENT_APPROVED', 'DOCUMENT_ERP_SEND_REQUESTED', 'DOCUMENT_ERP_SEND_COMPLETED', 'DOCUMENT_SIGNED', 'WORKFLOW_STAGE_CHANGED', 'DATA_IMPORTED', 'LK_REFERENCE_SYNCED', 'LK_EVENT_APPLIED', 'COMMUNICATION_REQUESTED', 'COMMUNICATION_COMPLETED', 'DOCUMENT_OCR_RETRIED', 'DOCUMENT_OCR_REQUESTED', 'ANNOTATION_CATALOG_CHANGED', 'ANNOTATION_PREFERENCE_CHANGED', 'ANNOTATION_CLAIMED', 'ANNOTATION_SAVED', 'ANNOTATION_SUBMITTED', 'ANNOTATION_ACCEPTED', 'ANNOTATION_CHANGES_REQUESTED', 'ANNOTATION_REASSIGNED', 'CONTRACT_CREATED', 'CONTRACT_FILE_REPLACED', 'CONTRACT_SENT', 'CONTRACT_CONFIRMED', 'CONTRACT_DECLINED', 'CONTRACT_PREPARATION_FAILED', 'DOCUMENT_ABSENCE_REPORTED', 'DOCUMENT_ABSENCE_DECIDED') NOT NULL;

ALTER TABLE `candidate_previous_documents`
  ADD COLUMN `erpEditSyncStatus` VARCHAR(16) NULL,
  ADD COLUMN `erpEditSyncError` VARCHAR(128) NULL;

UPDATE `document_types` SET `multipleInstancesAllowed`=true WHERE LOWER(`erpUid`) IN (
'3f164241-8c5b-11eb-ba8b-00259002db81', '10fa3e03-751b-11ec-80cd-002590854e7f',
'a18522de-8341-11eb-ba8b-00259002db81', '402ec3c2-3cf6-11f0-89f3-00505601221a',
'bdf50265-5469-11ef-89df-00505601221a');

ALTER TABLE `candidate_previous_documents` ADD COLUMN `erpEditRequestId` VARCHAR(36) NULL;

ALTER TABLE `documents` ADD COLUMN `acceptedVersion` INTEGER NULL;

CREATE TABLE `candidate_employment_notifications` (
  `id` VARCHAR(64) NOT NULL,
  `candidateId` VARCHAR(64) NOT NULL,
  `confirmationKey` VARCHAR(128) NOT NULL,
  `recipientCodes1c` JSON NOT NULL,
  `title` VARCHAR(256) NOT NULL,
  `content` TEXT NOT NULL,
  `targetUrl` VARCHAR(1024) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `leaseUntil` DATETIME(3) NULL,
  `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `sentAt` DATETIME(3) NULL,
  `lastError` VARCHAR(128) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `employment_notifications_candidate_confirmation_key` (`candidateId`, `confirmationKey`),
  INDEX `candidate_employment_notifications_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `candidate_employment_notifications_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `candidates` ADD COLUMN `employmentObservationPending` BOOLEAN NOT NULL DEFAULT false;
