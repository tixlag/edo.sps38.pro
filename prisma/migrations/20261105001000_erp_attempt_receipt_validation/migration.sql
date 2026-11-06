ALTER TABLE `erp_document_attempts` ADD COLUMN `receiptValidated` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `candidates` ADD COLUMN `igCompletionVerified` BOOLEAN NOT NULL DEFAULT false;
