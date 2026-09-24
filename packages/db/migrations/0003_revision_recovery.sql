-- Recovery boundaries for drafts, revisions, moderation and media bindings.
--
-- Before this migration a published feature kept only current_revision_id and
-- the contributor's in-flight revision was implicitly "the latest revision
-- number". When the in-flight revision was rejected the owner-facing API had
-- no explicit pointer to it, so the edit page fell back to the old public
-- revision and the contributor's changes appeared lost.

-- The revision the contributor is currently working on (draft / pending /
-- rejected / changes_requested). It is independent of current_revision_id,
-- which always points at the publicly visible revision.
ALTER TABLE map_features
  ADD COLUMN draft_revision_id uuid REFERENCES feature_revisions(id) ON DELETE SET NULL;

-- Why a media asset is detached from a revision (removal while editing,
-- replacement on a new revision, owner deletion). Kept for audit/recovery.
ALTER TABLE media_assets
  ADD COLUMN detach_reason text;

-- Backfill draft_revision_id for existing rows: the latest revision when it is
-- not the published current one, otherwise there is no in-flight draft.
UPDATE map_features mf
SET draft_revision_id = latest.id
FROM LATERAL (
  SELECT id
  FROM feature_revisions
  WHERE feature_id = mf.id
  ORDER BY revision_no DESC
  LIMIT 1
) latest
WHERE mf.draft_revision_id IS NULL
  AND latest.id IS DISTINCT FROM mf.current_revision_id;

-- A published feature must always keep its public revision; only one
-- in-flight revision (the draft pointer) may exist at a time.
CREATE UNIQUE INDEX map_features_draft_revision_idx
  ON map_features(draft_revision_id)
  WHERE draft_revision_id IS NOT NULL;
