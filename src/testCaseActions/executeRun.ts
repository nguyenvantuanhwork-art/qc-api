import { getPool } from "../db";
import { listActions } from "./store";
import { runTestActions } from "./runner";
import type { RunTestCaseResult } from "./types";
import { insertTestRun } from "../testRuns/store";
import { getProjectIdForTestCase } from "./projectContext";
import { mergeProjectSettings } from "../projects/projectSettings";

const running = new Set<string>();

async function loadProjectSettingsForTestCase(testCaseId: string) {
  const pool = getPool();
  const pid = await getProjectIdForTestCase(testCaseId);
  if (!pid) return mergeProjectSettings({});
  const r = await pool.query<{ settings: unknown }>(`select settings from projects where id = $1`, [pid]);
  return mergeProjectSettings(r.rows[0]?.settings ?? {});
}

export function isTestCaseRunLocked(testCaseId: string): boolean {
  return running.has(testCaseId);
}

/**
 * Chạy toàn bộ bước của test case + ghi test_runs. Dùng cho HTTP và lịch tự động.
 */
export async function executeTestCaseRun(
  testCaseId: string,
  triggeredByUserId: string | null,
): Promise<{ ok: boolean; result?: RunTestCaseResult; error?: string }> {
  if (running.has(testCaseId)) {
    return { ok: false, error: "Test case đang chạy, đợi hoàn tất." };
  }
  running.add(testCaseId);
  try {
    const actionsList = await listActions(testCaseId);
    if (actionsList.length === 0) {
      return { ok: false, error: "Chưa có hành động nào để chạy." };
    }
    const projectSettings = await loadProjectSettingsForTestCase(testCaseId);
    const maxAttempts = projectSettings.runner.runRetries + 1;
    let result: RunTestCaseResult | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      result = await runTestActions(actionsList, projectSettings);
      if (result.ok) break;
    }
    if (!result) {
      return { ok: false, error: "Lỗi chạy test." };
    }
    try {
      await insertTestRun(testCaseId, result, triggeredByUserId);
    } catch (err) {
      console.error("[test_runs:insert]", err instanceof Error ? err.message : err);
    }
    return { ok: true, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  } finally {
    running.delete(testCaseId);
  }
}
