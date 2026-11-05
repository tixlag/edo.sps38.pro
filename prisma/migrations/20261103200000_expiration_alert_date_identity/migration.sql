ALTER TABLE `document_expiration_alerts`
  DROP INDEX `uniq_doc_alert`,
  DROP INDEX `uniq_prevdoc_alert`,
  ADD UNIQUE INDEX `uniq_doc_alert` (`documentId`, `expiresAt`, `thresholdDays`, `recipientCode1c`),
  ADD UNIQUE INDEX `uniq_prevdoc_alert` (`previousDocId`, `expiresAt`, `thresholdDays`, `recipientCode1c`);
