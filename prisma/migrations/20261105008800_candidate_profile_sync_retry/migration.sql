ALTER TABLE `candidates`
  ADD COLUMN `profileSyncNextAttemptAt` DATETIME(3) NULL,
  ADD COLUMN `profileSyncAttempts` INT NOT NULL DEFAULT 0;

CREATE INDEX `candidates_profileSyncNextAttemptAt_idx`
  ON `candidates` (`profileSyncNextAttemptAt`);
