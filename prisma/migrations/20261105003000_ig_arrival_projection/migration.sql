CREATE TABLE `ig_arrival_persons` (
 `personUid` VARCHAR(36) NOT NULL, `code1c` VARCHAR(64) NOT NULL,
 `revision` BIGINT NOT NULL DEFAULT 0, `state` VARCHAR(16) NOT NULL,
 `currentMemberUid` VARCHAR(36) NULL, `candidateId` VARCHAR(64) NULL,
 `sourceHash` VARCHAR(64) NOT NULL, `sourcePayload` JSON NOT NULL,
 `syncedRevision` BIGINT NOT NULL DEFAULT 0, `syncError` VARCHAR(64) NULL,
 `bindingError` VARCHAR(64) NULL, `updatedAt` DATETIME(3) NOT NULL,
 UNIQUE INDEX `ig_arrival_persons_code1c_key` (`code1c`),
 UNIQUE INDEX `ig_arrival_persons_currentMemberUid_key` (`currentMemberUid`),
 UNIQUE INDEX `ig_arrival_persons_candidateId_key` (`candidateId`),
 INDEX `ig_arrival_persons_state_personUid_idx` (`state`, `personUid`),
 PRIMARY KEY (`personUid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `ig_arrival_members` (
 `arrivalMemberUid` VARCHAR(36) NOT NULL, `personUid` VARCHAR(36) NOT NULL,
 `arrivalDate` CHAR(10) NULL, `locationUid` VARCHAR(36) NULL,
 `locationCode1c` VARCHAR(512) NULL, `locationName` VARCHAR(512) NULL,
 `fullName` VARCHAR(512) NULL, `citizenship` VARCHAR(2) NULL,
 `managerCode1c` VARCHAR(512) NULL, `cancelled` BOOLEAN NOT NULL,
 INDEX `ig_arrival_members_arrivalDate_locationUid_idx` (`arrivalDate`, `locationUid`),
 INDEX `ig_arrival_members_personUid_idx` (`personUid`), PRIMARY KEY (`arrivalMemberUid`),
 CONSTRAINT `ig_arrival_members_personUid_fkey` FOREIGN KEY (`personUid`) REFERENCES `ig_arrival_persons` (`personUid`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `ig_arrival_persons` ADD CONSTRAINT `ig_arrival_persons_currentMemberUid_fkey` FOREIGN KEY (`currentMemberUid`) REFERENCES `ig_arrival_members` (`arrivalMemberUid`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ig_arrival_persons` ADD CONSTRAINT `ig_arrival_persons_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `candidates` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
