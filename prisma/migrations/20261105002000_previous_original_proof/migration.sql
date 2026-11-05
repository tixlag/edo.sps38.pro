ALTER TABLE `candidate_previous_documents` ADD COLUMN `originalVerified` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `candidates` ADD COLUMN `igRequirementsConflict` BOOLEAN NOT NULL DEFAULT false;
