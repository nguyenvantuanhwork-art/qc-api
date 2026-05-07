import { listActions } from "../testCaseActions/store";
import type { TestAction } from "../testCaseActions/types";
import { listDirectPrerequisiteIds } from "./store";

/**
 * Gộp các bước theo cây phụ thuộc (mỗi test case chỉ đóng góp actions một lần — thứ tự DFS).
 * `order` được gán lại tuần tự để runner sort đúng.
 */
export async function listExpandedActionsForRun(rootTestCaseId: string): Promise<TestAction[]> {
  const seenTc = new Set<string>();
  const merged: TestAction[] = [];

  async function visit(tcId: string): Promise<void> {
    if (seenTc.has(tcId)) {
      return;
    }
    const prereqs = await listDirectPrerequisiteIds(tcId);
    for (const p of prereqs) {
      await visit(p);
    }
    seenTc.add(tcId);
    const acts = await listActions(tcId);
    merged.push(...acts);
  }

  await visit(rootTestCaseId);

  for (let i = 0; i < merged.length; i++) {
    const a = merged[i]!;
    merged[i] = { ...a, order: i };
  }
  return merged;
}
