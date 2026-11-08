ALTER TABLE `ig_arrival_members`
  ADD COLUMN `arrivalDateTime` CHAR(19) NULL,
  ADD COLUMN `lastSeenRevision` BIGINT NULL;

-- The saved payload is the complete source snapshot at the person's revision.
-- Missing members are retained but are not claimed to be cancelled or present.
UPDATE `ig_arrival_members` m
JOIN `ig_arrival_persons` p ON p.`personUid` = m.`personUid`
SET m.`lastSeenRevision` = p.`revision`
WHERE p.`revision` > 0
  AND JSON_CONTAINS(p.`sourcePayload`, JSON_OBJECT('arrivalMemberUid', m.`arrivalMemberUid`), '$.participations') = 1;

CREATE INDEX `ig_arrival_members_lastSeenRevision_arrivalDate_locationUid_idx`
  ON `ig_arrival_members` (`lastSeenRevision`, `arrivalDate`, `locationUid`);
