export type RunOverallStatus = "passed" | "failed";

export interface TestRunRow {
  id: string;
  testCaseId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  overallStatus: RunOverallStatus;
  triggeredByUsername?: string | null;
}

/** Dòng danh sách lịch sử toàn cục (sidebar). */
export interface GlobalTestRunListRow extends TestRunRow {
  testCaseName: string | null;
  testCaseKey: string | null;
  featureId: string | null;
  featureName: string | null;
  featureKey: string | null;
  projectId: string | null;
  projectName: string | null;
  projectKey: string | null;
  hasScreenshots: boolean;
}

export interface TestRunDetail extends TestRunRow {
  result: unknown;
}

