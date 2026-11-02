ALTER TABLE `document_type_stage_positions` ADD COLUMN `required` BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE `document_type_stage_projects` (
  `id` VARCHAR(64) NOT NULL, `ruleId` VARCHAR(64) NOT NULL, `code1c` VARCHAR(64) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `document_type_stage_projects_ruleId_code1c_key` (`ruleId`, `code1c`),
  CONSTRAINT `document_type_stage_projects_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `document_type_stage_rules` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `document_type_stage_countries` (
  `id` VARCHAR(64) NOT NULL, `ruleId` VARCHAR(64) NOT NULL, `code` VARCHAR(64) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `document_type_stage_countries_ruleId_code_key` (`ruleId`, `code`),
  CONSTRAINT `document_type_stage_countries_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `document_type_stage_rules` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
UPDATE `document_types` SET `catalogSyncedAt` = LEAST(`catalogSyncedAt`, DATE_SUB(NOW(3), INTERVAL 25 HOUR)) WHERE `catalogSyncedAt` IS NOT NULL;
