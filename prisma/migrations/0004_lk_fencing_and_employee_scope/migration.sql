-- Fencing ledger for snapshot-vs-events + explicit Employee scope link.
-- LkSyncRun.id is the fencing generation (monotonic). Consumers check for
-- RUNNING rows atomically with the inbox write; markMissing runs only for the
-- latest RUNNING run holding the Redis lock.
CREATE TABLE IF NOT EXISTS `lk_sync_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `runId` VARCHAR(64) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finishedAt` DATETIME(3) NULL,
  `locations` INT NOT NULL DEFAULT 0,
  `positions` INT NOT NULL DEFAULT 0,
  `departments` INT NOT NULL DEFAULT 0,
  `employees` INT NOT NULL DEFAULT 0,
  `errorCategory` VARCHAR(64) NULL,
  `errorMessage` VARCHAR(1024) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `lk_sync_runs_runId_key` (`runId`),
  KEY `lk_sync_runs_status_idx` (`status`),
  KEY `lk_sync_runs_startedAt_idx` (`startedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Explicit Employee scope: nullable link to LK projection + explicit location object.
-- Existing rows keep NULL (unknown link, no object) — no guessing by fullName.
ALTER TABLE `employees` ADD COLUMN `lkEmployeeCode1c` VARCHAR(64) NULL, ADD COLUMN `locationId` INT NULL;
CREATE INDEX `employees_lkEmployeeCode1c_idx` ON `employees` (`lkEmployeeCode1c`);
CREATE INDEX `employees_locationId_idx` ON `employees` (`locationId`);
