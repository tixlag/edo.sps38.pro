ALTER TABLE `ig_grant_events` MODIFY COLUMN `candidateId` VARCHAR(64) NULL;
ALTER TABLE `ig_grant_events` ADD COLUMN `personUid` VARCHAR(36) NULL;
ALTER TABLE `ig_grant_events` ADD COLUMN `citizenship` VARCHAR(16) NULL;
ALTER TABLE `ig_grant_events` ADD COLUMN `enabled` BOOLEAN NULL;
ALTER TABLE `ig_grant_events` ADD COLUMN `payloadHash` VARCHAR(64) NULL;
