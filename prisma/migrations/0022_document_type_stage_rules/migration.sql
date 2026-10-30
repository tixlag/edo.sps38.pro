CREATE TABLE `document_type_stage_rules` (
  `id` VARCHAR(64) NOT NULL,
  `documentTypeId` VARCHAR(64) NOT NULL,
  `stage` INTEGER NULL,
  `requiredForAll` BOOLEAN NOT NULL DEFAULT false,
  `allRu` BOOLEAN NOT NULL DEFAULT false,
  `allForeign` BOOLEAN NOT NULL DEFAULT false,
  INDEX `document_type_stage_rules_documentTypeId_idx` (`documentTypeId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `document_type_stage_rules_documentTypeId_fkey` FOREIGN KEY (`documentTypeId`) REFERENCES `document_types`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `document_type_stage_positions` (
  `id` VARCHAR(64) NOT NULL,
  `ruleId` VARCHAR(64) NOT NULL,
  `code1c` VARCHAR(64) NOT NULL,
  UNIQUE INDEX `document_type_stage_positions_ruleId_code1c_key` (`ruleId`, `code1c`),
  PRIMARY KEY (`id`),
  CONSTRAINT `document_type_stage_positions_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `document_type_stage_rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO `document_type_stage_rules` (`id`, `documentTypeId`, `stage`, `requiredForAll`, `allRu`, `allForeign`)
SELECT UUID(), `id`, `stage`, `requiredForAll`, `allRu`, `allForeign` FROM `document_types` WHERE `catalogSyncedAt` IS NOT NULL;
INSERT INTO `document_type_stage_positions` (`id`, `ruleId`, `code1c`)
SELECT UUID(), r.`id`, p.`code1c` FROM `document_type_stage_rules` r JOIN `document_type_positions` p ON p.`documentTypeId` = r.`documentTypeId`;
-- Keep the old snapshot readable while forcing a refresh with per-stage rules.
UPDATE `document_types` SET `catalogSyncedAt` = LEAST(`catalogSyncedAt`, DATE_SUB(NOW(3), INTERVAL 25 HOUR)) WHERE `catalogSyncedAt` IS NOT NULL;
