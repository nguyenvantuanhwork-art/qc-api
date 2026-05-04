export type ActionKind = "navigate" | "click_selector" | "click_text" | "type" | "wait";

export interface ActionConfig {
  /** navigate */
  url?: string;
  /** click_selector, type */
  selector?: string;
  /** click_text — tìm nút/link chứa chuỗi (không phân biệt hoa thường) */
  matchText?: string;
  /** type */
  value?: string;
  /** wait (ms) */
  waitMs?: number;
}

export interface TestAction {
  id: string;
  testCaseId: string;
  order: number;
  kind: ActionKind;
  name: string;
  enabled: boolean;
  config: ActionConfig;
  expectation?: string;
  createdAt: string;
  updatedAt: string;
}

export type StepStatus = "passed" | "failed" | "skipped";

export interface RunStepResult {
  actionId: string;
  order: number;
  name: string;
  kind: ActionKind;
  status: StepStatus;
  message?: string;
  url?: string;
  screenshotBase64?: string;
  durationMs: number;
}

export interface RunTestCaseResult {
  ok: boolean;
  testCaseId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  overallStatus: "passed" | "failed";
  steps: RunStepResult[];
  error?: string;
}
