ALTER TABLE `candidates`
  ADD COLUMN `previousDocumentsSyncedAt` DATETIME(3) NULL;

CREATE INDEX `candidates_previousDocumentsSyncedAt_idx`
  ON `candidates` (`previousDocumentsSyncedAt`);
