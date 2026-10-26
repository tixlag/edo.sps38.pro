-- Canonical WebP bytes use the existing fields; source provenance is additive.
ALTER TABLE `document_version_files`
  ADD COLUMN `sourceFilename` VARCHAR(255) NULL,
  ADD COLUMN `sourceMimeType` VARCHAR(128) NULL,
  ADD COLUMN `sourceSizeBytes` INTEGER NULL,
  ADD COLUMN `sourceSha256` VARCHAR(64) NULL,
  ADD COLUMN `normalization` VARCHAR(32) NULL;
