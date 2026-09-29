-- Create fundamental tables (first slice). Workflow/requirements/signing extend later.
CREATE TABLE IF NOT EXISTS `employees` (
  `id` VARCHAR(64) NOT NULL,
  `fullName` VARCHAR(255) NOT NULL,
  `country` VARCHAR(128) NULL,
  `position` VARCHAR(255) NULL,
  `status` ENUM('INVITED','ONBOARDING','BLOCKED','IN_REVIEW','SIGNING','HIRED') NOT NULL DEFAULT 'INVITED',
  `stage` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `employees_status_idx` (`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `document_types` (
  `id` VARCHAR(64) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `document_types_code_key` (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `documents` (
  `id` VARCHAR(64) NOT NULL,
  `employeeId` VARCHAR(64) NOT NULL,
  `documentTypeId` VARCHAR(64) NULL,
  `status` ENUM('DRAFT','UPLOADED','OCR_PENDING','OCR_FAILED','IN_REVIEW','RETURNED','APPROVED','SIGNED','EXPIRED') NOT NULL DEFAULT 'DRAFT',
  `currentVersion` INT NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `documents_employeeId_idx` (`employeeId`),
  KEY `documents_status_idx` (`status`),
  CONSTRAINT `documents_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `documents_documentTypeId_fkey` FOREIGN KEY (`documentTypeId`) REFERENCES `document_types` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `document_versions` (
  `id` VARCHAR(64) NOT NULL,
  `documentId` VARCHAR(64) NOT NULL,
  `version` INT NOT NULL,
  `storageKey` VARCHAR(1024) NOT NULL,
  `mimeType` VARCHAR(128) NULL,
  `sizeBytes` INT NULL,
  `ocrRaw` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `document_versions_documentId_version_key` (`documentId`, `version`),
  CONSTRAINT `document_versions_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `documents` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tasks` (
  `id` VARCHAR(64) NOT NULL,
  `title` VARCHAR(512) NOT NULL,
  `assignee` VARCHAR(255) NULL,
  `employeeId` VARCHAR(64) NULL,
  `status` ENUM('TODO','IN_PROGRESS','DONE') NOT NULL DEFAULT 'TODO',
  `dueDate` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `tasks_status_idx` (`status`),
  CONSTRAINT `tasks_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` VARCHAR(64) NOT NULL,
  `actorId` VARCHAR(64) NULL,
  `action` ENUM('EMPLOYEE_CREATED','DOCUMENT_UPLOADED','DOCUMENT_RETURNED','DOCUMENT_APPROVED','DOCUMENT_SIGNED','WORKFLOW_STAGE_CHANGED','DATA_IMPORTED') NOT NULL,
  `entityType` VARCHAR(64) NOT NULL,
  `entityId` VARCHAR(64) NOT NULL,
  `before` JSON NULL,
  `after` JSON NULL,
  `correlationId` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `employeeId` VARCHAR(64) NULL,
  `documentId` VARCHAR(64) NULL,
  PRIMARY KEY (`id`),
  KEY `audit_logs_entityType_entityId_idx` (`entityType`, `entityId`),
  KEY `audit_logs_createdAt_idx` (`createdAt`),
  CONSTRAINT `audit_logs_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `audit_logs_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `documents` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
