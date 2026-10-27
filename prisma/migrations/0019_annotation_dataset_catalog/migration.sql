-- DropForeignKey
ALTER TABLE `annotation_field_answers` DROP FOREIGN KEY `annotation_field_answers_annotationId_fkey`;

-- DropIndex
DROP INDEX `annotation_field_answers_annotationId_key_key` ON `annotation_field_answers`;

-- AlterTable
ALTER TABLE `annotation_catalog_families` MODIFY `profile` VARCHAR(64) NOT NULL;

-- AlterTable
ALTER TABLE `annotation_catalog_fields` ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'TEXT',
    ADD COLUMN `sectionKey` VARCHAR(64) NOT NULL DEFAULT 'main';

-- AlterTable
ALTER TABLE `annotation_field_answers` ADD COLUMN `instanceId` VARCHAR(64) NOT NULL DEFAULT 'main';

-- CreateTable
CREATE TABLE `annotation_catalog_sections` (
    `id` VARCHAR(64) NOT NULL,
    `catalogId` VARCHAR(64) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `repeatable` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `annotation_catalog_sections_catalogId_key_key`(`catalogId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_section_instances` (
    `id` VARCHAR(64) NOT NULL,
    `annotationId` VARCHAR(64) NOT NULL,
    `clientId` VARCHAR(64) NOT NULL,
    `sectionKey` VARCHAR(64) NOT NULL,
    `availability` VARCHAR(24) NOT NULL,

    UNIQUE INDEX `annotation_section_instances_annotationId_clientId_key`(`annotationId`, `clientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_section_pages` (
    `instanceId` VARCHAR(64) NOT NULL,
    `pageId` VARCHAR(96) NOT NULL,

    PRIMARY KEY (`instanceId`, `pageId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_regions` (
    `id` VARCHAR(64) NOT NULL,
    `answerId` VARCHAR(64) NOT NULL,
    `clientId` VARCHAR(64) NOT NULL,
    `pageId` VARCHAR(96) NOT NULL,
    `shape` VARCHAR(16) NOT NULL,
    `orientationDeg` DOUBLE NOT NULL,

    UNIQUE INDEX `annotation_regions_answerId_clientId_key`(`answerId`, `clientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_region_vertices` (
    `regionId` VARCHAR(64) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `x` DOUBLE NOT NULL,
    `y` DOUBLE NOT NULL,

    PRIMARY KEY (`regionId`, `ordinal`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `annotation_field_answers_annotationId_key_instanceId_key` ON `annotation_field_answers`(`annotationId`, `key`, `instanceId`);

-- AddForeignKey
ALTER TABLE `annotation_field_answers` ADD CONSTRAINT `annotation_field_answers_annotationId_fkey` FOREIGN KEY (`annotationId`) REFERENCES `document_annotations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_catalog_sections` ADD CONSTRAINT `annotation_catalog_sections_catalogId_fkey` FOREIGN KEY (`catalogId`) REFERENCES `annotation_catalogs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_section_instances` ADD CONSTRAINT `annotation_section_instances_annotationId_fkey` FOREIGN KEY (`annotationId`) REFERENCES `document_annotations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_section_pages` ADD CONSTRAINT `annotation_section_pages_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `annotation_section_instances`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_regions` ADD CONSTRAINT `annotation_regions_answerId_fkey` FOREIGN KEY (`answerId`) REFERENCES `annotation_field_answers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_region_vertices` ADD CONSTRAINT `annotation_region_vertices_regionId_fkey` FOREIGN KEY (`regionId`) REFERENCES `annotation_regions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

