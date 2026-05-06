import type { RunStepResult, RunTestCaseResult } from "../testCaseActions/types";
import { getR2Context, presignGetScreenshot, putScreenshotPng } from "../r2/s3Client";
import { updateTestRunResult } from "./store";

/** Key an toàn cho object path (uuid / chữ/số/ghi)._ */
export function screenshotObjectKeyForStep(runId: string, step: Pick<RunStepResult, "order" | "actionId">): string {
  const id = step.actionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return `test-runs/${runId}/${step.order}-${id}.png`;
}

/**
 * Sau khi insert test_runs: đẩy ảnh PNG lên R2, bỏ base64 khỏi JSON, ghi screenshotObjectKey.
 * Bước upload lỗi vẫn giữ base64 cho bước đó. Không có R2 thì trả nguyên result.
 */
export async function persistRunScreenshotsAfterInsert(runId: string, result: RunTestCaseResult): Promise<RunTestCaseResult> {
  if (!getR2Context()) {
    return result;
  }

  const clone = JSON.parse(JSON.stringify(result)) as RunTestCaseResult;
  let changed = false;

  for (const step of clone.steps) {
    const b64 = step.screenshotBase64?.trim();
    if (!b64) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (!buf.length) continue;

    const key = screenshotObjectKeyForStep(runId, step);
    try {
      await putScreenshotPng(key, buf);
      delete step.screenshotBase64;
      step.screenshotObjectKey = key;
      changed = true;
    } catch (e) {
      console.error("[r2:put screenshot]", step.actionId, e instanceof Error ? e.message : e);
    }
  }

  if (changed) {
    try {
      await updateTestRunResult(runId, clone);
    } catch (e) {
      console.error("[test_runs:update result after r2]", e instanceof Error ? e.message : e);
    }
  }

  return clone;
}

/**
 * Chuẩn bị result gửi client: presign screenshotObjectKey → screenshotUrl, không trả object key.
 * Dữ liệu cũ chỉ có base64 vẫn giữ nguyên.
 */
export async function runResultForPublicApi(result: RunTestCaseResult): Promise<RunTestCaseResult> {
  const out = JSON.parse(JSON.stringify(result)) as RunTestCaseResult;

  await Promise.all(
    out.steps.map(async (step) => {
      const key = step.screenshotObjectKey?.trim();
      delete step.screenshotObjectKey;
      if (!key || !getR2Context()) {
        return;
      }
      try {
        const url = await presignGetScreenshot(key);
        if (url) step.screenshotUrl = url;
      } catch (e) {
        console.error("[r2:presign]", step.actionId, e instanceof Error ? e.message : e);
      }
    }),
  );

  return out;
}
