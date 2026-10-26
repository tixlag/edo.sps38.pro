ALTER TABLE `document_version_fields` ADD COLUMN `ocrText` TEXT NULL;
UPDATE `document_version_fields` SET `ocrText` = `originalValue` WHERE `originalValue` IS NOT NULL;
-- Restore exact text for unambiguous existing observations. UZ passport numbers
-- feed separate series/number requisites, so retain their already split values.
UPDATE `document_version_fields` AS f
JOIN (
  SELECT `versionId`, `documentFieldName`, MIN(`value`) AS `value`
  FROM `document_version_ocr_fields`
  WHERE `documentFieldName` IS NOT NULL AND `name` <> 'pas_number'
    AND `value` IS NOT NULL AND LENGTH(TRIM(`value`)) > 0
  GROUP BY `versionId`, `documentFieldName` HAVING COUNT(*) = 1
) AS o ON o.`versionId` = f.`versionId` AND o.`documentFieldName` = f.`name`
SET f.`ocrText` = o.`value`;

ALTER TABLE `ocr_regions` MODIFY `fieldId` VARCHAR(64) NULL,
  ADD COLUMN `ocrFieldId` VARCHAR(64) NULL;
CREATE INDEX `ocr_regions_ocrFieldId_idx` ON `ocr_regions`(`ocrFieldId`);
ALTER TABLE `ocr_regions` ADD CONSTRAINT `ocr_regions_ocrFieldId_fkey`
  FOREIGN KEY (`ocrFieldId`) REFERENCES `document_version_ocr_fields`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
