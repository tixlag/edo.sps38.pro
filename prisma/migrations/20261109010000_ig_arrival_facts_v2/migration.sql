ALTER TABLE `ig_arrival_persons`
  DROP INDEX `ig_arrival_persons_code1c_key`,
  ADD INDEX `ig_arrival_persons_code1c_idx` (`code1c`),
  MODIFY `code1c` VARCHAR(64) NULL,
  ADD COLUMN `rawSourceCode1c` TEXT NULL,
  ADD COLUMN `factsSeenGeneration` BIGINT NULL,
  ADD COLUMN `factsMissingPasses` INT NOT NULL DEFAULT 0;
ALTER TABLE `ig_arrival_members`
  ADD COLUMN `sourceKey` VARCHAR(128) NULL,
  ADD COLUMN `sourceMemberUid` VARCHAR(36) NULL,
  ADD COLUMN `factsSeenGeneration` BIGINT NULL,
  ADD COLUMN `factsMissingPasses` INT NOT NULL DEFAULT 0,
  ADD COLUMN `factsArchived` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `latestSiteStatusCancelled` BOOLEAN NULL,
  ADD COLUMN `factsIdentityIssue` VARCHAR(64) NULL,
  ADD UNIQUE INDEX `ig_arrival_members_sourceKey_key` (`sourceKey`),
  ADD INDEX `ig_arrival_members_sourceMemberUid_idx` (`sourceMemberUid`);

ALTER TABLE `ig_arrival_sync_state` ADD COLUMN `factsFinishedGeneration` BIGINT NULL, ADD COLUMN `factsScanGeneration` BIGINT NULL, ADD COLUMN `factsScanIncomplete` BOOLEAN NOT NULL DEFAULT false;
