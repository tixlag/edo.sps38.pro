ALTER TABLE `candidates` ADD COLUMN `igCompletedAt` DATETIME(3) NULL;

CREATE TABLE `ig_employment_states` (
  `code1c` VARCHAR(64) NOT NULL,
  `currentCandidateId` VARCHAR(64) NULL,
  PRIMARY KEY (`code1c`),
  UNIQUE INDEX `ig_employment_states_currentCandidateId_key` (`currentCandidateId`),
  CONSTRAINT `ig_employment_states_currentCandidateId_fkey` FOREIGN KEY (`currentCandidateId`) REFERENCES `candidates` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ig_grant_events` (
  `id` VARCHAR(36) NOT NULL,
  `code1c` VARCHAR(64) NOT NULL,
  `candidateId` VARCHAR(64) NOT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
