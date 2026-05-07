/**
 * Cài đặt cấp dự án (cột `projects.settings` JSONB, merge với mặc định).
 */

export type ScreenshotPolicy = "every_step" | "on_failure";

export interface ResolvedProjectSettings {
  runner: {
    defaultStepTimeoutMs: number;
    navigateTimeoutMs: number;
    waitStepMaxMs: number;
    screenshotPolicy: ScreenshotPolicy;
    /**
     * Khi false: chỉ chụp màn hình các bước thuộc testcase đang chạy (gốc),
     * không chụp bước của gói/tiên quyết đã mở rộng phía trước (trừ policy vẫn áp dụng).
     */
    screenshotPrerequisiteSteps: boolean;
    headless: boolean;
    viewportWidth: number;
    viewportHeight: number;
    runRetries: number;
    defaultBaseUrl: string;
  };
  ai: {
    enabled: boolean;
  };
}

const DEFAULTS: ResolvedProjectSettings = {
  runner: {
    defaultStepTimeoutMs: 20_000,
    navigateTimeoutMs: 60_000,
    waitStepMaxMs: 120_000,
    screenshotPolicy: "every_step",
    screenshotPrerequisiteSteps: true,
    headless: true,
    viewportWidth: 1280,
    viewportHeight: 800,
    runRetries: 0,
    defaultBaseUrl: "",
  },
  ai: {
    enabled: true,
  },
};

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : "";
}

/** Merge DB JSON với mặc định (an toàn khi client gửi thiếu / sai kiểu). */
export function mergeProjectSettings(raw: unknown): ResolvedProjectSettings {
  const out: ResolvedProjectSettings = {
    runner: { ...DEFAULTS.runner },
    ai: { ...DEFAULTS.ai },
  };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;

  const runner = o.runner;
  if (runner && typeof runner === "object") {
    const r = runner as Record<string, unknown>;
    if (typeof r.defaultStepTimeoutMs === "number") {
      out.runner.defaultStepTimeoutMs = clamp(r.defaultStepTimeoutMs, 3_000, 120_000);
    }
    if (typeof r.navigateTimeoutMs === "number") {
      out.runner.navigateTimeoutMs = clamp(r.navigateTimeoutMs, 10_000, 180_000);
    }
    if (typeof r.waitStepMaxMs === "number") {
      out.runner.waitStepMaxMs = clamp(r.waitStepMaxMs, 1_000, 120_000);
    }
    if (r.screenshotPolicy === "every_step" || r.screenshotPolicy === "on_failure") {
      out.runner.screenshotPolicy = r.screenshotPolicy;
    }
    if (typeof r.screenshotPrerequisiteSteps === "boolean") {
      out.runner.screenshotPrerequisiteSteps = r.screenshotPrerequisiteSteps;
    }
    if (typeof r.headless === "boolean") {
      out.runner.headless = r.headless;
    }
    if (typeof r.viewportWidth === "number") {
      out.runner.viewportWidth = clamp(r.viewportWidth, 320, 3840);
    }
    if (typeof r.viewportHeight === "number") {
      out.runner.viewportHeight = clamp(r.viewportHeight, 240, 2160);
    }
    if (typeof r.runRetries === "number") {
      out.runner.runRetries = clamp(r.runRetries, 0, 5);
    }
    const base = asNonEmptyString(r.defaultBaseUrl);
    if (base !== undefined) {
      out.runner.defaultBaseUrl = base;
    }
  }

  const ai = o.ai;
  if (ai && typeof ai === "object") {
    const a = ai as Record<string, unknown>;
    if (typeof a.enabled === "boolean") {
      out.ai.enabled = a.enabled;
    }
  }

  return out;
}

/** PATCH một phần — chỉ ghi các key được gửi (sau validate). */
export function mergePatchIntoStored(
  currentRaw: unknown,
  patch: unknown,
): { ok: true; stored: Record<string, unknown> } | { ok: false; error: string } {
  const merged = mergeProjectSettings(currentRaw);
  if (!patch || typeof patch !== "object") {
    return { ok: false, error: "Body phải là object." };
  }
  const p = patch as Record<string, unknown>;
  const next: ResolvedProjectSettings = {
    runner: { ...merged.runner },
    ai: { ...merged.ai },
  };

  if ("runner" in p) {
    const pr = p.runner;
    if (pr !== undefined && (typeof pr !== "object" || pr === null)) {
      return { ok: false, error: "runner phải là object." };
    }
    if (pr && typeof pr === "object") {
      const r = pr as Record<string, unknown>;
      if ("defaultStepTimeoutMs" in r) {
        if (typeof r.defaultStepTimeoutMs !== "number")
          return { ok: false, error: "runner.defaultStepTimeoutMs phải là số." };
        next.runner.defaultStepTimeoutMs = clamp(r.defaultStepTimeoutMs, 3_000, 120_000);
      }
      if ("navigateTimeoutMs" in r) {
        if (typeof r.navigateTimeoutMs !== "number")
          return { ok: false, error: "runner.navigateTimeoutMs phải là số." };
        next.runner.navigateTimeoutMs = clamp(r.navigateTimeoutMs, 10_000, 180_000);
      }
      if ("waitStepMaxMs" in r) {
        if (typeof r.waitStepMaxMs !== "number")
          return { ok: false, error: "runner.waitStepMaxMs phải là số." };
        next.runner.waitStepMaxMs = clamp(r.waitStepMaxMs, 1_000, 120_000);
      }
      if ("screenshotPolicy" in r) {
        if (r.screenshotPolicy !== "every_step" && r.screenshotPolicy !== "on_failure") {
          return { ok: false, error: "runner.screenshotPolicy không hợp lệ." };
        }
        next.runner.screenshotPolicy = r.screenshotPolicy;
      }
      if ("screenshotPrerequisiteSteps" in r) {
        if (typeof r.screenshotPrerequisiteSteps !== "boolean")
          return { ok: false, error: "runner.screenshotPrerequisiteSteps phải boolean." };
        next.runner.screenshotPrerequisiteSteps = r.screenshotPrerequisiteSteps;
      }
      if ("headless" in r) {
        if (typeof r.headless !== "boolean") return { ok: false, error: "runner.headless phải boolean." };
        next.runner.headless = r.headless;
      }
      if ("viewportWidth" in r) {
        if (typeof r.viewportWidth !== "number") return { ok: false, error: "runner.viewportWidth phải là số." };
        next.runner.viewportWidth = clamp(r.viewportWidth, 320, 3840);
      }
      if ("viewportHeight" in r) {
        if (typeof r.viewportHeight !== "number")
          return { ok: false, error: "runner.viewportHeight phải là số." };
        next.runner.viewportHeight = clamp(r.viewportHeight, 240, 2160);
      }
      if ("runRetries" in r) {
        if (typeof r.runRetries !== "number") return { ok: false, error: "runner.runRetries phải là số." };
        next.runner.runRetries = clamp(r.runRetries, 0, 5);
      }
      if ("defaultBaseUrl" in r) {
        if (typeof r.defaultBaseUrl !== "string") {
          return { ok: false, error: "runner.defaultBaseUrl phải là chuỗi." };
        }
        next.runner.defaultBaseUrl = r.defaultBaseUrl.trim();
      }
    }
  }

  if ("ai" in p) {
    const pa = p.ai;
    if (pa !== undefined && (typeof pa !== "object" || pa === null)) {
      return { ok: false, error: "ai phải là object." };
    }
    if (pa && typeof pa === "object") {
      const a = pa as Record<string, unknown>;
      if ("enabled" in a) {
        if (typeof a.enabled !== "boolean") return { ok: false, error: "ai.enabled phải boolean." };
        next.ai.enabled = a.enabled;
      }
    }
  }

  /** Lưu dạng “diff so với default” để JSON gọn; vẫn merge được khi đọc. */
  const stored: Record<string, unknown> = {};
  const dr = next.runner;
  const ddr = DEFAULTS.runner;
  const runnerPart: Record<string, unknown> = {};
  if (dr.defaultStepTimeoutMs !== ddr.defaultStepTimeoutMs) runnerPart.defaultStepTimeoutMs = dr.defaultStepTimeoutMs;
  if (dr.navigateTimeoutMs !== ddr.navigateTimeoutMs) runnerPart.navigateTimeoutMs = dr.navigateTimeoutMs;
  if (dr.waitStepMaxMs !== ddr.waitStepMaxMs) runnerPart.waitStepMaxMs = dr.waitStepMaxMs;
  if (dr.screenshotPolicy !== ddr.screenshotPolicy) runnerPart.screenshotPolicy = dr.screenshotPolicy;
  if (dr.screenshotPrerequisiteSteps !== ddr.screenshotPrerequisiteSteps)
    runnerPart.screenshotPrerequisiteSteps = dr.screenshotPrerequisiteSteps;
  if (dr.headless !== ddr.headless) runnerPart.headless = dr.headless;
  if (dr.viewportWidth !== ddr.viewportWidth) runnerPart.viewportWidth = dr.viewportWidth;
  if (dr.viewportHeight !== ddr.viewportHeight) runnerPart.viewportHeight = dr.viewportHeight;
  if (dr.runRetries !== ddr.runRetries) runnerPart.runRetries = dr.runRetries;
  if (dr.defaultBaseUrl !== ddr.defaultBaseUrl) runnerPart.defaultBaseUrl = dr.defaultBaseUrl;
  if (Object.keys(runnerPart).length) stored.runner = runnerPart;

  if (next.ai.enabled !== DEFAULTS.ai.enabled) {
    stored.ai = { enabled: next.ai.enabled };
  }

  return { ok: true, stored };
}

export function getDefaultProjectSettings(): ResolvedProjectSettings {
  return {
    runner: { ...DEFAULTS.runner },
    ai: { ...DEFAULTS.ai },
  };
}
