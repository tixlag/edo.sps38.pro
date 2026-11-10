ALTER TABLE `document_submissions` ADD COLUMN `origin` VARCHAR(16) NOT NULL DEFAULT 'CANDIDATE', ADD COLUMN `uploadedBy` VARCHAR(64) NULL;
ALTER TABLE `candidate_previous_documents` ADD COLUMN `erpFields` JSON NULL, ADD COLUMN `localRevision` INTEGER NOT NULL DEFAULT 0;
CREATE TABLE `candidate_previous_document_field_edits` (
  `previousDocumentId` VARCHAR(64) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `value` TEXT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `editedBy` VARCHAR(64) NOT NULL,
  `editedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`previousDocumentId`, `name`),
  CONSTRAINT `previous_document_field_edit_document_fk` FOREIGN KEY (`previousDocumentId`) REFERENCES `candidate_previous_documents` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
