-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('EMPLOYEE_CREATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_UPLOAD_STARTED', 'DOCUMENT_UPLOAD_FAILED', 'DOCUMENT_OCR_COMPLETED', 'DOCUMENT_FIELDS_UPDATED', 'CANDIDATE_LINKED', 'DOCUMENT_RETURNED', 'DOCUMENT_APPROVED', 'DOCUMENT_ERP_SEND_REQUESTED', 'DOCUMENT_ERP_SEND_COMPLETED', 'DOCUMENT_SIGNED', 'WORKFLOW_STAGE_CHANGED', 'DATA_IMPORTED', 'LK_REFERENCE_SYNCED', 'LK_EVENT_APPLIED', 'DOCUMENT_OCR_RETRIED', 'DOCUMENT_OCR_REQUESTED', 'ANNOTATION_CATALOG_CHANGED', 'ANNOTATION_PREFERENCE_CHANGED', 'ANNOTATION_CLAIMED', 'ANNOTATION_SAVED', 'ANNOTATION_SUBMITTED', 'ANNOTATION_ACCEPTED', 'ANNOTATION_CHANGES_REQUESTED', 'ANNOTATION_REASSIGNED') NOT NULL;

-- CreateTable
CREATE TABLE `annotation_catalog_families` (
    `id` VARCHAR(64) NOT NULL,
    `documentTypeCode` VARCHAR(64) NOT NULL,
    `profile` VARCHAR(8) NOT NULL,

    UNIQUE INDEX `annotation_catalog_families_documentTypeCode_profile_key`(`documentTypeCode`, `profile`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_catalogs` (
    `id` VARCHAR(64) NOT NULL,
    `familyId` VARCHAR(64) NOT NULL,
    `version` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    `draftSlot` INTEGER NULL DEFAULT 1,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `title` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `annotation_catalogs_familyId_version_key`(`familyId`, `version`),
    UNIQUE INDEX `annotation_catalogs_familyId_draftSlot_key`(`familyId`, `draftSlot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_catalog_fields` (
    `id` VARCHAR(64) NOT NULL,
    `catalogId` VARCHAR(64) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `ordinal` INTEGER NOT NULL,
    `multiline` BOOLEAN NOT NULL DEFAULT false,
    `businessFieldName` VARCHAR(128) NULL,

    UNIQUE INDEX `annotation_catalog_fields_catalogId_key_key`(`catalogId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_catalog_suggestions` (
    `id` VARCHAR(64) NOT NULL,
    `catalogId` VARCHAR(64) NOT NULL,
    `authorId` VARCHAR(64) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_preferences` (
    `actorId` VARCHAR(64) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`actorId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_annotations` (
    `id` VARCHAR(64) NOT NULL,
    `versionId` VARCHAR(64) NOT NULL,
    `catalogId` VARCHAR(64) NOT NULL,
    `authorId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
    `revision` INTEGER NOT NULL DEFAULT 0,
    `schemaSnapshot` JSON NOT NULL,
    `sourceSnapshot` JSON NOT NULL,
    `note` VARCHAR(2000) NULL,
    `submittedAt` DATETIME(3) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `document_annotations_versionId_key`(`versionId`),
    INDEX `document_annotations_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_field_answers` (
    `id` VARCHAR(64) NOT NULL,
    `annotationId` VARCHAR(64) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `disposition` VARCHAR(16) NOT NULL,

    UNIQUE INDEX `annotation_field_answers_annotationId_key_key`(`annotationId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_lines` (
    `id` VARCHAR(64) NOT NULL,
    `answerId` VARCHAR(64) NOT NULL,
    `clientId` VARCHAR(64) NOT NULL,
    `pageId` VARCHAR(96) NOT NULL,
    `order` INTEGER NOT NULL,
    `text` VARCHAR(2000) NOT NULL,
    `x0` DOUBLE NOT NULL,
    `y0` DOUBLE NOT NULL,
    `x1` DOUBLE NOT NULL,
    `y1` DOUBLE NOT NULL,
    `x2` DOUBLE NOT NULL,
    `y2` DOUBLE NOT NULL,
    `x3` DOUBLE NOT NULL,
    `y3` DOUBLE NOT NULL,

    UNIQUE INDEX `annotation_lines_answerId_order_key`(`answerId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `annotation_snapshots` (
    `id` VARCHAR(64) NOT NULL,
    `annotationId` VARCHAR(64) NOT NULL,
    `revision` INTEGER NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `annotation_snapshots_status_idx`(`status`),
    UNIQUE INDEX `annotation_snapshots_annotationId_revision_key`(`annotationId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `annotation_catalogs` ADD CONSTRAINT `annotation_catalogs_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `annotation_catalog_families`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_catalog_fields` ADD CONSTRAINT `annotation_catalog_fields_catalogId_fkey` FOREIGN KEY (`catalogId`) REFERENCES `annotation_catalogs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_catalog_suggestions` ADD CONSTRAINT `annotation_catalog_suggestions_catalogId_fkey` FOREIGN KEY (`catalogId`) REFERENCES `annotation_catalogs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_annotations` ADD CONSTRAINT `document_annotations_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `document_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_annotations` ADD CONSTRAINT `document_annotations_catalogId_fkey` FOREIGN KEY (`catalogId`) REFERENCES `annotation_catalogs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_field_answers` ADD CONSTRAINT `annotation_field_answers_annotationId_fkey` FOREIGN KEY (`annotationId`) REFERENCES `document_annotations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_lines` ADD CONSTRAINT `annotation_lines_answerId_fkey` FOREIGN KEY (`answerId`) REFERENCES `annotation_field_answers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `annotation_snapshots` ADD CONSTRAINT `annotation_snapshots_annotationId_fkey` FOREIGN KEY (`annotationId`) REFERENCES `document_annotations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
