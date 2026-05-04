export interface ScheduleListRow {
  id: string;
  testCaseId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string;
  createdAt: string;
  testCaseName: string | null;
  featureId: string | null;
  featureName: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Cùng nhóm → worker chạy lần lượt, cách nhau theo staggerSeconds */
  scheduleGroupId: string | null;
  staggerSeconds: number;
}
