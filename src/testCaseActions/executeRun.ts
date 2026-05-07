import { getPool } from "../db";
import { listExpandedActionsForRun } from "../testCasePrerequisites/expandForRun";
import { runTestActions } from "./runner";
import type { RunTestCaseResult } from "./types";
import { insertTestRun } from "../testRuns/store";
import { persistRunScreenshotsAfterInsert, runResultForPublicApi } from "../testRuns/screenshotUrls";
import { getProjectIdForTestCase } from "./projectContext";
import { mergeProjectSettings } from "../projects/projectSettings";
import {
  clearActiveRun,
  hasActiveRun,
  listActiveRunPublicSnapshots,
  registerActiveRun,
  requestCancelActiveRun,
  updateActiveRunProgress,
} from "./activeRunRegistry";

async function loadProjectSettingsForTestCase(testCaseId: string) {
  const pool = getPool();
  const pid = await getProjectIdForTestCase(testCaseId);
  if (!pid) return mergeProjectSettings({});
  const r = await pool.query<{ settings: unknown }>(`select settings from projects where id = $1`, [pid]);
  return mergeProjectSettings(r.rows[0]?.settings ?? {});
}

async function lookupUsername(userId: string): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query<{ username: string }>(`select username from users where id = $1::uuid`, [userId]);
  return r.rows[0]?.username ?? null;
}

export function isTestCaseRunLocked(testCaseId: string): boolean {
  return hasActiveRun(testCaseId);
}

export { listActiveRunPublicSnapshots, requestCancelActiveRun };

/**
 * Chạy toàn bộ bước của test case + ghi test_runs. Dùng cho HTTP và lịch tự động.
 */
export async function executeTestCaseRun(
  testCaseId: string,
  triggeredByUserId: string | null,
  options?: { source?: "manual" | "schedule" },
): Promise<{ ok: boolean; result?: RunTestCaseResult; error?: string }> {
  if (hasActiveRun(testCaseId)) {
    return { ok: false, error: "Test case đang chạy, đợi hoàn tất." };
  }

  const abortController = new AbortController();
  const source = options?.source ?? "manual";
  let triggeredByUsername: string | null = null;
  const uid = triggeredByUserId?.trim() || null;
  if (uid) {
    try {
      triggeredByUsername = await lookupUsername(uid);
    } catch {
      triggeredByUsername = null;
    }
  }

  const actionsList = await listExpandedActionsForRun(testCaseId);
  if (actionsList.length === 0) {
    return { ok: false, error: "Chưa có hành động nào để chạy." };
  }
  const totalPrep = actionsList.length;

  registerActiveRun(testCaseId, {
    startedAt: new Date().toISOString(),
    triggeredByUserId: uid,
    triggeredByUsername,
    source,
    abortController,
    progress: {
      stepOrdinal: 0,
      totalSteps: totalPrep,
      stepName: "",
      stepKind: "wait",
    },
  });

  try {
    const projectSettings = await loadProjectSettingsForTestCase(testCaseId);
    const maxAttempts = projectSettings.runner.runRetries + 1;
    let result: RunTestCaseResult | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      result = await runTestActions(actionsList, projectSettings, {
        signal: abortController.signal,
        runRootTestCaseId: testCaseId,
        onProgress: ({ stepOrdinal, totalSteps, action }) => {
          updateActiveRunProgress(testCaseId, {
            stepOrdinal,
            totalSteps,
            stepName: action.name,
            stepKind: action.kind,
          });
        },
      });
      result = { ...result, testCaseId };
      if (result.cancelled) break;
      if (result.ok) break;
    }
    if (!result) {
      return { ok: false, error: "Lỗi chạy test." };
    }
    let runId: string | null = null;
    try {
      const row = await insertTestRun(testCaseId, result, triggeredByUserId);
      runId = row.id;
    } catch (err) {
      console.error("[test_runs:insert]", err instanceof Error ? err.message : err);
    }
    if (runId) {
      try {
        result = await persistRunScreenshotsAfterInsert(runId, result);
      } catch (err) {
        console.error("[test_runs:r2]", err instanceof Error ? err.message : err);
      }
    }
    try {
      result = await runResultForPublicApi(result);
    } catch (err) {
      console.error("[test_runs:presign]", err instanceof Error ? err.message : err);
    }
    if (result.cancelled) {
      return { ok: false, result, error: result.error ?? "Đã dừng." };
    }
    return { ok: true, result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  } finally {
    clearActiveRun(testCaseId);
  }
}
