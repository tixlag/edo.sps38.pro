CREATE TABLE `ig_arrival_issues` (
  `id` CHAR(64) NOT NULL, `personHash` CHAR(64) NOT NULL,
  `revision` BIGINT NULL, `code` VARCHAR(64) NOT NULL,
  `active` BOOLEAN NOT NULL DEFAULT true, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `ig_arrival_issues_personHash_active_idx` (`personHash`, `active`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
