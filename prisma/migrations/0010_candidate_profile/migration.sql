-- Extend candidates with the LK candidate profile snapshot (review queue filters).
-- All snapshot columns are nullable (unknown = NULL); uploads that carry no
-- snapshot never touch them (see ManualDocumentService.reserve).
ALTER TABLE `candidates` ADD COLUMN `fullName` VARCHAR(512) NULL,
    ADD COLUMN `birthDate` DATE NULL,
    ADD COLUMN `citizenship` VARCHAR(2) NULL,
    ADD COLUMN `positionCode` VARCHAR(64) NULL,
    ADD COLUMN `positionName` VARCHAR(512) NULL,
    ADD COLUMN `projectCode` VARCHAR(64) NULL,
    ADD COLUMN `projectName` VARCHAR(512) NULL,
    ADD COLUMN `managerName` VARCHAR(512) NULL,
    ADD COLUMN `managerCode1c` VARCHAR(64) NULL,
    ADD COLUMN `mentorName` VARCHAR(512) NULL,
    ADD COLUMN `mentorPosition` VARCHAR(512) NULL,
    ADD COLUMN `mentorCode1c` VARCHAR(64) NULL,
    ADD COLUMN `isReemployment` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `profileSyncedAt` DATETIME(3) NULL;
