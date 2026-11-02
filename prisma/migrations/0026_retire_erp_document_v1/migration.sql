-- Existing v1 deliveries remain unchanged for manual reconciliation.
ALTER TABLE `erp_document_deliveries` ALTER COLUMN `transport` SET DEFAULT 'multipart-v2';
