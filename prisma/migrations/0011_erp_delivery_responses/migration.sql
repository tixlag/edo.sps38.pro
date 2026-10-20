ALTER TABLE `erp_document_attempts`
    ADD COLUMN `httpStatus` INTEGER NULL,
    ADD COLUMN `responseBody` TEXT NULL,
    ADD COLUMN `responseTruncated` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `responseReadError` VARCHAR(64) NULL;
