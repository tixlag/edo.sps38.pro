ALTER TABLE `candidate_previous_documents` ADD COLUMN `sourceErpId` VARCHAR(256) NULL;
ALTER TABLE `ig_arrival_persons` ADD COLUMN `targetedPendingRevision` BIGINT NULL, ADD COLUMN `targetedAppliedRevision` BIGINT NULL;
