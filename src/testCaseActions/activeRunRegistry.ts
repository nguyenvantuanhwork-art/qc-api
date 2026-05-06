import type { ActionKind } from "./types";

export type ActiveRunSource = "manual" | "schedule";

export type ActiveRunProgress = {
  stepOrdinal: number;
  totalSteps: number;
  stepName: string;
  stepKind: ActionKind;
};

export type ActiveRunEntry = {
  startedAt: string;
  triggeredByUserId: string | null;
  triggeredByUsername: string | null;
  source: ActiveRunSource;
  abortController: AbortController;
  progress: ActiveRunProgress;
};

const activeByTestCaseId = new Map<string, ActiveRunEntry>();

export function hasActiveRun(testCaseId: string): boolean {
  return activeByTestCaseId.has(testCaseId);
}

export function registerActiveRun(testCaseId: string, entry: ActiveRunEntry): void {
  activeByTestCaseId.set(testCaseId, entry);
}

export function clearActiveRun(testCaseId: string): void {
  activeByTestCaseId.delete(testCaseId);
}

export function updateActiveRunProgress(testCaseId: string, progress: ActiveRunProgress): void {
  const e = activeByTestCaseId.get(testCaseId);
  if (e) e.progress = progress;
}

export function requestCancelActiveRun(testCaseId: string): boolean {
  const e = activeByTestCaseId.get(testCaseId);
  if (!e) return false;
  e.abortController.abort();
  return true;
}

export type ActiveRunPublicSnapshot = {
  testCaseId: string;
  startedAt: string;
  triggeredByUserId: string | null;
  triggeredByUsername: string | null;
  source: ActiveRunSource;
  progress: ActiveRunProgress;
};

export function listActiveRunPublicSnapshots(): ActiveRunPublicSnapshot[] {
  return [...activeByTestCaseId.entries()].map(([testCaseId, e]) => ({
    testCaseId,
    startedAt: e.startedAt,
    triggeredByUserId: e.triggeredByUserId,
    triggeredByUsername: e.triggeredByUsername,
    source: e.source,
    progress: { ...e.progress },
  }));
}
