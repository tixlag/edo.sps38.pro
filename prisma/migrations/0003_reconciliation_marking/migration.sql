-- Reconciliation marking for full-snapshot missing rows.
-- lastSeenSyncId is stamped on every row seen during a full snapshot.
-- After a SUCCESSFUL snapshot, unseen rows are marked deleted (refs) or
-- sourcePresent=false (employees). Partial snapshots never mark missing.
-- fired remains a business dismissal status, never set by snapshot absence.
ALTER TABLE `lk_employees` ADD COLUMN `lastSeenSyncId` VARCHAR(64) NULL, ADD COLUMN `sourcePresent` BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE `lk_locations` ADD COLUMN `lastSeenSyncId` VARCHAR(64) NULL;
ALTER TABLE `lk_positions` ADD COLUMN `lastSeenSyncId` VARCHAR(64) NULL;
ALTER TABLE `lk_departments` ADD COLUMN `lastSeenSyncId` VARCHAR(64) NULL;
