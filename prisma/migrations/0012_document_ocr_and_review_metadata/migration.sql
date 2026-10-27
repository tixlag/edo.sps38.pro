ALTER TABLE `document_versions`
  ADD COLUMN `submittedAt` DATETIME(3) NULL,
  ADD COLUMN `reviewedAt` DATETIME(3) NULL,
  ADD COLUMN `reviewedBy` VARCHAR(64) NULL;

ALTER TABLE `ocr_jobs` MODIFY `status` ENUM('UPLOADING','QUEUED','RUNNING','SUCCEEDED','REJECTED','FAILED','CANCELLED') NOT NULL DEFAULT 'UPLOADING';

CREATE TABLE `document_version_ocr_fields` (
  `id` VARCHAR(64) NOT NULL,
  `versionId` VARCHAR(64) NOT NULL,
  `ordinal` INTEGER NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  `documentFieldName` VARCHAR(128) NULL,
  `value` TEXT NULL,
  `source` VARCHAR(16) NOT NULL,
  `paddleText` TEXT NULL,
  `paddleConfidence` DOUBLE NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `document_version_ocr_fields_versionId_ordinal_key` (`versionId`, `ordinal`),
  CONSTRAINT `document_version_ocr_fields_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Reservation/createdAt is not submission time. Only unambiguous upload audit events qualify.
UPDATE `document_versions` v
JOIN (
  SELECT `entityId`, JSON_UNQUOTE(JSON_EXTRACT(`after`, '$.version')) AS versionNumber,
         MIN(`createdAt`) AS submittedAt
  FROM `audit_logs`
  WHERE `action` = 'DOCUMENT_UPLOADED' AND `entityType` = 'Document'
  GROUP BY `entityId`, JSON_UNQUOTE(JSON_EXTRACT(`after`, '$.version'))
  HAVING COUNT(*) = 1
) a ON a.entityId = v.documentId AND a.versionNumber = CAST(v.version AS CHAR)
SET v.submittedAt = a.submittedAt;

UPDATE `document_versions` SET `reviewedAt` = `approvedAt`, `reviewedBy` = `approvedBy`
WHERE `approvedAt` IS NOT NULL;

UPDATE `document_versions` v
JOIN (
  SELECT `entityId`, JSON_UNQUOTE(JSON_EXTRACT(`after`, '$.version')) AS versionNumber,
         MIN(`createdAt`) AS reviewedAt, MIN(`actorId`) AS reviewedBy
  FROM `audit_logs`
  WHERE `action` = 'DOCUMENT_RETURNED' AND `entityType` = 'Document'
  GROUP BY `entityId`, JSON_UNQUOTE(JSON_EXTRACT(`after`, '$.version'))
  HAVING COUNT(*) = 1
) a ON a.entityId = v.documentId AND a.versionNumber = CAST(v.version AS CHAR)
SET v.reviewedAt = a.reviewedAt, v.reviewedBy = a.reviewedBy
WHERE v.status = 'RETURNED' AND v.reviewedAt IS NULL;
