ALTER TABLE `ig_arrival_sync_state`
    ADD COLUMN `lockToken` VARCHAR(64) NULL,
    ADD COLUMN `lockExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `generation` BIGINT NOT NULL DEFAULT 0;
