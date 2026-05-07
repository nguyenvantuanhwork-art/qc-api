export type ActionKind =
  | "navigate"
  | "click_selector"
  | "click_text"
  | "click_id"
  | "click_name"
  | "click_xpath"
  | "type"
  | "type_id"
  | "type_name"
  | "type_xpath"
  | "wait";

export interface ActionConfig {
  /** navigate */
  url?: string;
  /** click_selector, type */
  selector?: string;
  /** click_xpath, type_xpath */
  xpath?: string;
  /** click_text — tìm nút/link chứa chuỗi (không phân biệt hoa thường) */
  matchText?: string;
  /** click_id, type_id */
  id?: string;
  /** click_name, type_name (DOM attribute name="...") */
  name?: string;
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
  /** Chỉ lưu trong DB sau khi upload R2 thành công (API không trả field này cho client). */
  screenshotObjectKey?: string;
  /** Chỉ gắn khi trả response HTTP (presigned GET). */
  screenshotUrl?: string;
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
  /** Đặt khi người dùng gọi hủy — overallStatus vẫn failed để khớp DB. */
  cancelled?: boolean;
}
