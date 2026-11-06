ALTER TABLE `ig_arrival_persons` ADD COLUMN `syncPending` BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX `ig_arrival_persons_syncPending_updatedAt_idx` ON `ig_arrival_persons` (`syncPending`, `updatedAt`);
