/**
 * 修订恢复边界。
 *
 * 已发布内容的修订被驳回后，旧公开版本继续对公众可见；但作者的编辑视图
 * 必须恢复最新的工作修订（草稿 / 被驳回 / 待修改），否则表单会回退到旧
 * 公开版本，保存时从旧版本分叉出新修订，作者的改动随之丢失。
 */

export const EDITABLE_REVISION_STATUSES = ["draft", "rejected", "changes_requested"] as const;
export type EditableRevisionStatus = (typeof EDITABLE_REVISION_STATUSES)[number];

export const WORKING_REVISION_STATUSES = [
  "draft",
  "pending",
  "rejected",
  "changes_requested"
] as const;

export type RevisionState = {
  id: string;
  revisionNo: number;
  status: string;
};

export type PickedRevision = {
  revision: RevisionState;
  /** true 表示该修订处于可编辑状态，保存应覆盖它而不是创建新修订。 */
  editable: boolean;
};

/**
 * 选择编辑页应当加载的修订。
 *
 * 优先级：
 * 1. revision_no 最大的可编辑修订（draft/rejected/changes_requested）；
 * 2. 当前公开修订（currentRevisionId 指向的 published 修订）；
 * 3. 最新的 published 修订；
 * 4. revision_no 最大的修订（历史数据兜底）。
 */
export function pickWorkingRevision(
  revisions: RevisionState[],
  currentRevisionId: string | null
): PickedRevision | null {
  if (revisions.length === 0) return null;

  const ordered = [...revisions].sort((a, b) => b.revisionNo - a.revisionNo);
  const editable = ordered.find((item) =>
    (EDITABLE_REVISION_STATUSES as readonly string[]).includes(item.status)
  );
  if (editable) return { revision: editable, editable: true };

  if (currentRevisionId) {
    const current = ordered.find((item) => item.id === currentRevisionId);
    if (current) return { revision: current, editable: false };
  }

  const published = ordered.find((item) => item.status === "published");
  if (published) return { revision: published, editable: false };

  return { revision: ordered[0]!, editable: false };
}

/** 最新的非公开工作修订（含 pending），用于状态提示。 */
export function latestWorkingRevision(revisions: RevisionState[]): RevisionState | null {
  const ordered = [...revisions].sort((a, b) => b.revisionNo - a.revisionNo);
  return (
    ordered.find((item) => (WORKING_REVISION_STATUSES as readonly string[]).includes(item.status)) ?? null
  );
}
