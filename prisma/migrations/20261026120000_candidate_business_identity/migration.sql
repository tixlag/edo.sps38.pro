-- Historical rows intentionally remain unclassified until ERP confirms ownership.
ALTER TABLE candidates ADD COLUMN reviewGroup ENUM('RU','IG') NULL,
 ADD COLUMN personUid VARCHAR(36) NULL, ADD COLUMN phone VARCHAR(64) NULL,
 ADD COLUMN managerId VARCHAR(64) NULL, ADD COLUMN statusId VARCHAR(128) NULL,
 ADD COLUMN statusName VARCHAR(256) NULL;
ALTER TABLE documents ADD COLUMN reviewGroup ENUM('RU','IG') NULL;
ALTER TABLE document_stream_grants ADD COLUMN candidateId VARCHAR(64) NULL;
CREATE TABLE candidate_previous_documents (
 id VARCHAR(64) NOT NULL, candidateId VARCHAR(64) NOT NULL, sourceId VARCHAR(256) NOT NULL,
 documentUid VARCHAR(36) NULL, title VARCHAR(512) NOT NULL, fields JSON NOT NULL,
 expiresAt DATE NULL, originalAvailable BOOLEAN NOT NULL,
 status ENUM('REQUIRES_REVIEW','CONFIRMED','REPLACE','MISSING','ORIGINAL_UNAVAILABLE') NOT NULL DEFAULT 'REQUIRES_REVIEW',
 reviewedBy VARCHAR(64) NULL, reviewedAt DATETIME(3) NULL, updatedAt DATETIME(3) NOT NULL,
 PRIMARY KEY(id), UNIQUE INDEX candidate_previous_documents_candidateId_sourceId_key(candidateId,sourceId),
 CONSTRAINT candidate_previous_documents_candidateId_fkey FOREIGN KEY(candidateId) REFERENCES candidates(id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
