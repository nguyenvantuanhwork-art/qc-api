import puppeteer, { type Page } from "puppeteer";
import type { ActionConfig, RunStepResult, RunTestCaseResult, TestAction } from "./types";
import { validateConfig } from "./store";
import type { ResolvedProjectSettings } from "../projects/projectSettings";
import { mergeProjectSettings } from "../projects/projectSettings";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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
      await page.waitForSelector(sel, { visible: true, timeout: stepTimeout });
      await page.click(sel, { delay: 30 });
      return;
    }
    case "click_text": {
      const needle = config.matchText!.trim().toLowerCase();
      const clicked = await page.evaluate((n) => {
        const nodes = document.querySelectorAll("a, button, [role='button']");
        for (const el of nodes) {
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          if (text.includes(n)) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, needle);
      if (!clicked) {
        throw new Error(`Không tìm thấy nút/link chứa "${config.matchText}"`);
      }
      return;
    }
    case "type": {
      const sel = config.selector!.trim();
      await page.waitForSelector(sel, { visible: true, timeout: stepTimeout });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, String(config.value), { delay: 25 });
      return;
    }
    default:
      throw new Error(`Chưa hỗ trợ kind: ${kind}`);
  }
}

export async function runTestActions(
  actions: TestAction[],
  projectSettings: ResolvedProjectSettings,
): Promise<RunTestCaseResult> {
  const runner = projectSettings.runner;
  const sorted = [...actions].sort((a, b) => a.order - b.order);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const steps: RunStepResult[] = [];

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let page: Page | undefined;

  try {
    browser = await puppeteer.launch({
      headless: runner.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
    await page.setViewport({ width: runner.viewportWidth, height: runner.viewportHeight });

    for (const action of sorted) {
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
        await runStepOnPage(page, action, runner);
        let screenshotBase64: string | undefined;
        if (runner.screenshotPolicy === "every_step") {
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
        try {
          const shot = await page.screenshot({ type: "png", fullPage: false });
          shotB64 = Buffer.from(shot).toString("base64");
        } catch {
          /* bỏ qua nếu không chụp được */
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
