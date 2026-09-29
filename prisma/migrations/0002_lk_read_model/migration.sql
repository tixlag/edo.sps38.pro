-- LK master-data read model (local projection). Source of truth: lk.sps38.pro.
-- No runtime direct DB access to LK. Sync via snapshot API + RabbitMQ events.

CREATE TABLE IF NOT EXISTS `lk_employees` (
  `code1c` VARCHAR(64) NOT NULL,
  `uuid` VARCHAR(64) NOT NULL,
  `fullName` VARCHAR(512) NOT NULL,
  `birthday` DATETIME(3) NULL,
  `citizenship` VARCHAR(128) NULL,
  `organizationCode` VARCHAR(64) NULL,
  `organizationName` VARCHAR(512) NULL,
  `positionCode1c` VARCHAR(64) NULL,
  `positionName` VARCHAR(512) NULL,
  `departmentCode1c` VARCHAR(64) NULL,
  `departmentName` VARCHAR(512) NULL,
  `divisionCode1c` VARCHAR(64) NULL,
  `divisionName` VARCHAR(512) NULL,
  `lastLocationId` INT NULL,
  `lastLocationCode1c` VARCHAR(64) NULL,
  `lastLocationName` VARCHAR(512) NULL,
  `hireDate` DATETIME(3) NULL,
  `fired` BOOLEAN NOT NULL DEFAULT false,
  `contractor` BOOLEAN NOT NULL DEFAULT false,
  `sourceUpdatedAt` DATETIME(3) NULL,
  `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`code1c`),
  KEY `lk_employees_uuid_idx` (`uuid`),
  KEY `lk_employees_fired_idx` (`fired`),
  KEY `lk_employees_syncedAt_idx` (`syncedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lk_locations` (
  `code1c` VARCHAR(64) NOT NULL,
  `locationId` INT NOT NULL,
  `name` VARCHAR(512) NOT NULL,
  `shortName` VARCHAR(512) NOT NULL DEFAULT '',
  `generalUnitCode` VARCHAR(64) NULL,
  `deleted` BOOLEAN NOT NULL DEFAULT false,
  `sourceUpdatedAt` DATETIME(3) NULL,
  `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`code1c`),
  UNIQUE KEY `lk_locations_locationId_key` (`locationId`),
  KEY `lk_locations_deleted_idx` (`deleted`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lk_positions` (
  `code1c` VARCHAR(64) NOT NULL,
  `name` VARCHAR(512) NOT NULL,
  `deleted` BOOLEAN NOT NULL DEFAULT false,
  `sourceUpdatedAt` DATETIME(3) NULL,
  `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`code1c`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lk_departments` (
  `code1c` VARCHAR(64) NOT NULL,
  `name` VARCHAR(512) NOT NULL,
  `deleted` BOOLEAN NOT NULL DEFAULT false,
  `sourceUpdatedAt` DATETIME(3) NULL,
  `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`code1c`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lk_processed_events` (
  `eventId` VARCHAR(64) NOT NULL,
  `eventType` VARCHAR(128) NOT NULL,
  `version` INT NOT NULL DEFAULT 1,
  `occurredAt` DATETIME(3) NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `entityCode` VARCHAR(64) NULL,
  PRIMARY KEY (`eventId`),
  KEY `lk_processed_events_eventType_idx` (`eventType`),
  KEY `lk_processed_events_receivedAt_idx` (`receivedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Extend audit actions for LK sync (MySQL ENUM alter).
ALTER TABLE `audit_logs` MODIFY COLUMN `action` ENUM('EMPLOYEE_CREATED','DOCUMENT_UPLOADED','DOCUMENT_RETURNED','DOCUMENT_APPROVED','DOCUMENT_SIGNED','WORKFLOW_STAGE_CHANGED','DATA_IMPORTED','LK_REFERENCE_SYNCED','LK_EVENT_APPLIED') NOT NULL;
