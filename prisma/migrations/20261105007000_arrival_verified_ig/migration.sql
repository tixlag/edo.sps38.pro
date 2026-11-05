ALTER TABLE `ig_arrival_persons` ADD COLUMN `igVerified` BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX `ig_arrival_persons_igVerified_state_personUid_idx` ON `ig_arrival_persons` (`igVerified`, `state`, `personUid`);
