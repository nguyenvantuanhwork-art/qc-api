export interface ReportDayBucket {
  day: string;
  totalRuns: number;
  passed: number;
  failed: number;
  avgDurationMs: number;
}

export interface ReportTopFailingTestCase {
  testCaseId: string;
  testCaseName: string | null;
  projectName: string | null;
  totalRuns: number;
  failedRuns: number;
}

export interface ReportErrorTrend {
  errorKey: string;
  count: number;
  lastSeenAt: string;
}

export interface ReportSummary {
  days: number;
  projectId: string | null;
  totals: {
    totalRuns: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  series: ReportDayBucket[];
  topFailingTestCases: ReportTopFailingTestCase[];
  errorTrends: ReportErrorTrend[];
}
