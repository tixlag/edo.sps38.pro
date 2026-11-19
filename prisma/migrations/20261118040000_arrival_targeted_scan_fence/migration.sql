ALTER TABLE `ig_arrival_persons` ADD COLUMN `targetedAppliedAt` DATETIME(3) NULL;
ALTER TABLE `ig_arrival_sync_state` ADD COLUMN `factsScanStartedAt` DATETIME(3) NULL;
