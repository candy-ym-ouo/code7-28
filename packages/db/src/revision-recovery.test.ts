import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_revision_recovery.sql"),
  "utf8"
);

describe("revision recovery migration", () => {
  it("adds an explicit in-flight draft pointer separate from the public revision", () => {
    expect(migration).toContain("ADD COLUMN draft_revision_id uuid");
    expect(migration).toContain("REFERENCES feature_revisions(id) ON DELETE SET NULL");
  });

  it("backfills the draft pointer from the latest non-current revision", () => {
    expect(migration).toContain("SET draft_revision_id = latest.id");
    expect(migration).toContain("IS DISTINCT FROM mf.current_revision_id");
  });

  it("enforces a single in-flight revision per feature", () => {
    expect(migration).toContain("CREATE UNIQUE INDEX map_features_draft_revision_idx");
  });

  it("records why a media asset was detached for audit and recovery", () => {
    expect(migration).toContain("ADD COLUMN detach_reason text");
  });
});
