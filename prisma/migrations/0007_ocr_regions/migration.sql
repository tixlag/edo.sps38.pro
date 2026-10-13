CREATE TABLE `ocr_regions` (
  `id` VARCHAR(64) NOT NULL,
  `fieldId` VARCHAR(64) NOT NULL,
  `fileId` VARCHAR(64) NOT NULL,
  `pageNumber` INTEGER NOT NULL,
  `x` DOUBLE NOT NULL,
  `y` DOUBLE NOT NULL,
  `width` DOUBLE NOT NULL,
  `height` DOUBLE NOT NULL,
  `text` TEXT NULL,
  PRIMARY KEY (`id`),
  INDEX `ocr_regions_fieldId_idx` (`fieldId`),
  INDEX `ocr_regions_fileId_pageNumber_idx` (`fileId`, `pageNumber`),
  CONSTRAINT `ocr_regions_page_bounds` CHECK (`pageNumber` >= 1 AND `x` >= 0 AND `y` >= 0 AND `width` > 0 AND `height` > 0 AND `x` + `width` <= 1.000001 AND `y` + `height` <= 1.000001)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ocr_regions` ADD CONSTRAINT `ocr_regions_fieldId_fkey`
  FOREIGN KEY (`fieldId`) REFERENCES `document_version_fields`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ocr_regions` ADD CONSTRAINT `ocr_regions_fileId_fkey`
  FOREIGN KEY (`fileId`) REFERENCES `document_version_files`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
