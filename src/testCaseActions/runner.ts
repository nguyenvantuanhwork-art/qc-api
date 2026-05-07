import puppeteer, { type ElementHandle, type Page } from "puppeteer";
import type { ActionConfig, RunStepResult, RunTestCaseResult, TestAction } from "./types";
import { validateConfig } from "./store";
import type { ResolvedProjectSettings } from "../projects/projectSettings";
import { mergeProjectSettings } from "../projects/projectSettings";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Click thật qua CDP theo thứ tự tuyệt đối: move → down → up.
 * `Mouse.click()` của Puppeteer gộp move+down trong `Promise.all` khi không có delay,
 * hoặc move+down song song ngay cả khi có delay — dễ khiến trang chỉ nhận hover mà không nhận đủ nhấn chuột.
 */
async function clickElementSequential(page: Page, handle: ElementHandle<Element>): Promise<void> {
  await handle.scrollIntoView();
  const { x, y } = await handle.clickablePoint();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.down();
  await sleep(40);
  await page.mouse.up();
}

/** Ba lần nhấn liên tiếp (clickCount 1→3) để chọn hết nội dung ô nhập — từng cặp down/up tuần tự. */
async function tripleClickToSelectAll(page: Page, handle: ElementHandle<Element>): Promise<void> {
  await handle.scrollIntoView();
  const { x, y } = await handle.clickablePoint();
  await page.mouse.move(x, y, { steps: 6 });
  for (let clickCount = 1; clickCount <= 3; clickCount++) {
    await page.mouse.down({ clickCount });
    await page.mouse.up({ clickCount });
  }
}

async function waitElementById(page: Page, id: string, timeout: number): Promise<ElementHandle<Element>> {
  const trimmed = id.trim();
  const jsHandle = await page.waitForFunction(
    (domId) => document.getElementById(String(domId)),
    { timeout },
    trimmed,
  );
  const el = jsHandle.asElement() as ElementHandle<Element> | null;
  if (!el) {
    await jsHandle.dispose();
    throw new Error(`Không tìm thấy phần tử theo id="${trimmed}"`);
  }
  return el;
}

async function waitElementByName(page: Page, name: string, timeout: number): Promise<ElementHandle<Element>> {
  const trimmed = name.trim();
  const jsHandle = await page.waitForFunction(
    (domName) => document.querySelector(`[name="${CSS.escape(String(domName))}"]`),
    { timeout },
    trimmed,
  );
  const el = jsHandle.asElement() as ElementHandle<Element> | null;
  if (!el) {
    await jsHandle.dispose();
    throw new Error(`Không tìm thấy phần tử theo name="${trimmed}"`);
  }
  return el;
}

async function waitElementByXPath(page: Page, xpath: string, timeout: number): Promise<ElementHandle<Element>> {
  const trimmed = xpath.trim();
  const jsHandle = await page.waitForFunction(
    (xp) => {
      try {
        const r = document.evaluate(
          String(xp),
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        return r.singleNodeValue ?? null;
      } catch {
        return null;
      }
    },
    { timeout },
    trimmed,
  );
  const el = jsHandle.asElement() as ElementHandle<Element> | null;
  if (!el) {
    await jsHandle.dispose();
    throw new Error(`Không tìm thấy phần tử theo xpath="${trimmed}"`);
  }
  return el;
}

/** Chuẩn hoá URL navigate: URL tuyệt đối hoặc ghép với defaultBaseUrl của dự án. */
export function resolveNavigateUrl(url: string, defaultBaseUrl: string): string {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  const base = defaultBaseUrl.trim();
  if (!base) return u;
  try {
    const b = base.endsWith("/") ? base : `${base}/`;
    return new URL(u, b).href;
  } catch {
    return u;
  }
}

export async function runStepOnPage(
  page: Page,
  action: TestAction,
  runner: ResolvedProjectSettings["runner"],
): Promise<void> {
  const { kind, config } = action;
  const bad = validateConfig(kind, config);
  if (bad) throw new Error(bad);
  const stepTimeout = runner.defaultStepTimeoutMs;

  switch (kind) {
    case "navigate": {
      const rawUrl = config.url!.trim();
      const url = resolveNavigateUrl(rawUrl, runner.defaultBaseUrl);
      const response = await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: runner.navigateTimeoutMs,
      });
      const httpUrl = /^https?:\/\//i.test(url);
      if (httpUrl && response === null) {
        throw new Error(`Không nhận được phản hồi HTTP khi mở: ${url}`);
      }
      if (response !== null && !response.ok()) {
        const st = response.status();
        const reason = response.statusText()?.trim();
        throw new Error(`Tải trang lỗi HTTP ${st}${reason ? ` ${reason}` : ""} — ${url}`);
      }
      return;
    }
    case "wait": {
      await sleep(Math.min(config.waitMs!, runner.waitStepMaxMs));
      return;
    }
    case "click_selector": {
      const sel = config.selector!.trim();
      const handle = await page.waitForSelector(sel, { visible: true, timeout: stepTimeout });
      if (!handle) {
        throw new Error(`Không tìm thấy phần tử hiển thị cho selector: ${sel}`);
      }
      try {
        // Phải click đúng handle đã wait (visible), không dùng page.click(sel) —
        // page.click luôn lấy phần tử đầu tiên trong DOM, có thể khác phần tử đang hiển thị.
        await clickElementSequential(page, handle);
      } finally {
        await handle.dispose();
      }
      return;
    }
    case "click_text": {
      const needle = config.matchText!.trim().toLowerCase();
      const jsHandle = await page.evaluateHandle((n) => {
        const candidates = document.querySelectorAll(
          "a[href], button, input[type='button'], input[type='submit'], [role='button'], [role='link'], [role='menuitem'], [role='tab']",
        );
        for (const el of candidates) {
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          if (text.includes(n)) return el;
        }
        return null;
      }, needle);
      const target = jsHandle.asElement() as ElementHandle<Element> | null;
      if (!target) {
        await jsHandle.dispose();
        throw new Error(`Không tìm thấy nút/link chứa "${config.matchText}"`);
      }
      try {
        // Dùng chuột tuần tự (move/down/up), không HTMLElement.click() và không Mouse.click() gộp song song.
        await clickElementSequential(page, target);
      } finally {
        await target.dispose();
      }
      return;
    }
    case "click_id": {
      const id = config.id!.trim();
      const handle = await waitElementById(page, id, stepTimeout);
      try {
        await clickElementSequential(page, handle);
      } finally {
        await handle.dispose();
      }
      return;
    }
    case "click_name": {
      const name = config.name!.trim();
      const handle = await waitElementByName(page, name, stepTimeout);
      try {
        await clickElementSequential(page, handle);
      } finally {
        await handle.dispose();
      }
      return;
    }
    case "click_xpath": {
      const xp = config.xpath!.trim();
      const handle = await waitElementByXPath(page, xp, stepTimeout);
      try {
        await clickElementSequential(page, handle);
      } finally {
        await handle.dispose();
      }
      return;
    }
    case "type": {
      const sel = config.selector!.trim();
      const handle = await page.waitForSelector(sel, { visible: true, timeout: stepTimeout });
      if (!handle) {
        throw new Error(`Không tìm thấy phần tử hiển thị cho selector: ${sel}`);
      }
      try {
        await tripleClickToSelectAll(page, handle);
        await handle.type(String(config.value), { delay: 25 });
      } finally {
        await handle.dispose();
      }
      return;
    }
    case "type_id": {
      const id = config.id!.trim();
      const handle = await waitElementById(page, id, stepTimeout);
      try {
        await tripleClickToSelectAll(page, handle);
        await handle.type(String(config.value), { delay: 25 });
      } finally {
        await handle.dispose();
      }
      return;
    }
    case "type_name": {
      const name = config.name!.trim();
      const handle = await waitElementByName(page, name, stepTimeout);
      try {
        await tripleClickToSelectAll(page, handle);
        await handle.type(String(config.value), { delay: 25 });
      } finally {
        await handle.dispose();
      }
      return;
    }
    case "type_xpath": {
      const xp = config.xpath!.trim();
      const handle = await waitElementByXPath(page, xp, stepTimeout);
      try {
        await tripleClickToSelectAll(page, handle);
        await handle.type(String(config.value), { delay: 25 });
      } finally {
        await handle.dispose();
      }
      return;
    }
    default:
      throw new Error(`Chưa hỗ trợ kind: ${kind}`);
  }
}

export type RunTestActionsOptions = {
  signal?: AbortSignal;
  onProgress?: (p: { stepOrdinal: number; totalSteps: number; action: TestAction }) => void;
  /** Test case đang chạy (gốc). Khi có, dùng với `screenshotPrerequisiteSteps` để bỏ qua ảnh bước tiên quyết nếu cài đặt tắt. */
  runRootTestCaseId?: string;
};

function shouldAttachScreenshotForAction(
  action: TestAction,
  rootTestCaseId: string | undefined,
  capturePrerequisiteStepScreenshots: boolean,
): boolean {
  const root = rootTestCaseId?.trim();
  if (!root) return true;
  if (capturePrerequisiteStepScreenshots) return true;
  return action.testCaseId === root;
}

function buildCancelledResult(
  sorted: TestAction[],
  startedAt: string,
  t0: number,
  steps: RunStepResult[],
): RunTestCaseResult {
  const finishedAt = new Date().toISOString();
  return {
    ok: false,
    cancelled: true,
    testCaseId: sorted[0]?.testCaseId ?? "",
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    overallStatus: "failed",
    steps,
    error: "Đã dừng theo yêu cầu.",
  };
}

export async function runTestActions(
  actions: TestAction[],
  projectSettings: ResolvedProjectSettings,
  options?: RunTestActionsOptions,
): Promise<RunTestCaseResult> {
  const runner = projectSettings.runner;
  const sorted = [...actions].sort((a, b) => a.order - b.order);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const steps: RunStepResult[] = [];
  const signal = options?.signal;
  const totalSteps = sorted.length;
  const rootRunId = options?.runRootTestCaseId?.trim() || undefined;
  const capturePrereqShots = runner.screenshotPrerequisiteSteps;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let page: Page | undefined;

  try {
    if (signal?.aborted) {
      return buildCancelledResult(sorted, startedAt, t0, steps);
    }
    browser = await puppeteer.launch({
      headless: runner.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
    await page.setViewport({ width: runner.viewportWidth, height: runner.viewportHeight });
    await page.bringToFront().catch(() => {
      /* headless / môi trường không có cửa sổ */
    });

    for (let i = 0; i < sorted.length; i++) {
      const action = sorted[i]!;
      if (signal?.aborted) {
        return buildCancelledResult(sorted, startedAt, t0, steps);
      }
      options?.onProgress?.({ stepOrdinal: i + 1, totalSteps, action });
      const s0 = Date.now();
      if (!action.enabled) {
        steps.push({
          actionId: action.id,
          order: action.order,
          name: action.name,
          kind: action.kind,
          status: "skipped",
          message: "Bước đang tạm tắt",
          url: page.url(),
          durationMs: Date.now() - s0,
        });
        continue;
      }
      try {
        if (signal?.aborted) {
          return buildCancelledResult(sorted, startedAt, t0, steps);
        }
        await runStepOnPage(page, action, runner);
        let screenshotBase64: string | undefined;
        if (
          runner.screenshotPolicy === "every_step" &&
          shouldAttachScreenshotForAction(action, rootRunId, capturePrereqShots)
        ) {
          const shot = await page.screenshot({ type: "png", fullPage: false });
          screenshotBase64 = Buffer.from(shot).toString("base64");
        }
        steps.push({
          actionId: action.id,
          order: action.order,
          name: action.name,
          kind: action.kind,
          status: "passed",
          url: page.url(),
          screenshotBase64,
          durationMs: Date.now() - s0,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        let shotB64: string | undefined;
        if (shouldAttachScreenshotForAction(action, rootRunId, capturePrereqShots)) {
          try {
            const shot = await page.screenshot({ type: "png", fullPage: false });
            shotB64 = Buffer.from(shot).toString("base64");
          } catch {
            /* bỏ qua nếu không chụp được */
          }
        }
        steps.push({
          actionId: action.id,
          order: action.order,
          name: action.name,
          kind: action.kind,
          status: "failed",
          message: msg,
          url: page.url(),
          screenshotBase64: shotB64,
          durationMs: Date.now() - s0,
        });
        break;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const finishedAt = new Date().toISOString();
    return {
      ok: false,
      testCaseId: sorted[0]?.testCaseId ?? "",
      startedAt,
      finishedAt,
      durationMs: Date.now() - t0,
      overallStatus: "failed",
      steps,
      error: msg,
    };
  } finally {
    await browser?.close();
  }

  const finishedAt = new Date().toISOString();
  const failed = steps.some((s) => s.status === "failed");
  const firstFailed = steps.find((s) => s.status === "failed");
  return {
    ok: !failed,
    testCaseId: sorted[0]?.testCaseId ?? "",
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    overallStatus: failed ? "failed" : "passed",
    steps,
    ...(failed && firstFailed?.message ? { error: firstFailed.message } : {}),
  };
}

/** Chạy testcase với cài đặt mặc định (không có dự án / test nhanh). */
export async function runTestActionsWithDefaults(actions: TestAction[]): Promise<RunTestCaseResult> {
  return runTestActions(actions, mergeProjectSettings({}));
}
