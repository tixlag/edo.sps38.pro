-- Create index for the audit-history listing (author + action + time order).
CREATE INDEX `audit_logs_actor_action_created_idx` ON `audit_logs`(`actorId`, `action`, `createdAt`);
