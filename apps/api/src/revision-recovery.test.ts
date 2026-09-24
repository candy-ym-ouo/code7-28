import { describe, expect, it } from "vitest";
import { latestWorkingRevision, pickWorkingRevision } from "./revision-recovery";

function revision(id: string, revisionNo: number, status: string) {
  return { id, revisionNo, status };
}

describe("pickWorkingRevision", () => {
  it("restores the rejected working revision instead of the published current revision", () => {
    const published = revision("rev-1", 1, "published");
    const rejected = revision("rev-2", 2, "rejected");
    const picked = pickWorkingRevision([published, rejected], "rev-1");
    expect(picked?.revision.id).toBe("rev-2");
    expect(picked?.editable).toBe(true);
  });

  it("restores the changes_requested revision after a moderator asks for edits", () => {
    const picked = pickWorkingRevision(
      [revision("rev-1", 1, "published"), revision("rev-3", 3, "changes_requested")],
      "rev-1"
    );
    expect(picked?.revision.id).toBe("rev-3");
    expect(picked?.editable).toBe(true);
  });

  it("restores a draft revision when no published version exists yet", () => {
    const picked = pickWorkingRevision([revision("rev-1", 1, "draft")], null);
    expect(picked?.revision.id).toBe("rev-1");
    expect(picked?.editable).toBe(true);
  });

  it("picks the newest editable revision when several were rejected", () => {
    const picked = pickWorkingRevision(
      [
        revision("rev-1", 1, "published"),
        revision("rev-2", 2, "rejected"),
        revision("rev-3", 3, "rejected")
      ],
      "rev-1"
    );
    expect(picked?.revision.id).toBe("rev-3");
  });

  it("falls back to the current published revision when no editable revision exists", () => {
    const picked = pickWorkingRevision(
      [
        revision("rev-1", 1, "published"),
        revision("rev-2", 2, "pending")
      ],
      "rev-1"
    );
    expect(picked?.revision.id).toBe("rev-1");
    expect(picked?.editable).toBe(false);
  });

  it("falls back to the newest published revision when the current pointer is stale", () => {
    const picked = pickWorkingRevision(
      [revision("rev-1", 1, "published"), revision("rev-2", 2, "published")],
      "rev-9"
    );
    expect(picked?.revision.id).toBe("rev-2");
    expect(picked?.editable).toBe(false);
  });

  it("returns null when there are no revisions at all", () => {
    expect(pickWorkingRevision([], null)).toBeNull();
  });

  it("does not depend on input ordering", () => {
    const picked = pickWorkingRevision(
      [revision("rev-2", 2, "rejected"), revision("rev-1", 1, "published")],
      "rev-1"
    );
    expect(picked?.revision.id).toBe("rev-2");
  });
});

describe("latestWorkingRevision", () => {
  it("reports the pending revision so the UI can hide the edit entry", () => {
    expect(latestWorkingRevision([
      revision("rev-1", 1, "published"),
      revision("rev-2", 2, "pending")
    ])?.id).toBe("rev-2");
  });

  it("returns null when only published revisions exist", () => {
    expect(latestWorkingRevision([revision("rev-1", 1, "published")])).toBeNull();
  });
});
