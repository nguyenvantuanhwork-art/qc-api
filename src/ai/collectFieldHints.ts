import type { Page } from "puppeteer";
import type { TestAction } from "../testCaseActions/types";
import { runStepOnPage } from "../testCaseActions/runner";
import type { ResolvedProjectSettings } from "../projects/projectSettings";
import { mergeProjectSettings } from "../projects/projectSettings";

export type FieldHint = {
  actionId: string;
  selector: string;
  pageUrl?: string;
  tagName?: string;
  inputType?: string;
  htmlName?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  autocomplete?: string;
  labelsText?: string;
  domError?: string;
};

/**
 * Chạy tuần tự các bước; với bước `type` nằm trong targetIds thì chỉ đọc metadata DOM, không gõ.
 * Các bước `type` khác vẫn được thực thi (cần đã có value hợp lệ).
 */
export async function collectFieldHintsForActions(
  page: Page,
  sorted: TestAction[],
  targetIds: Set<string>,
  runner: ResolvedProjectSettings["runner"] = mergeProjectSettings({}).runner,
): Promise<Map<string, FieldHint>> {
  const out = new Map<string, FieldHint>();

  for (const action of sorted) {
    if (!action.enabled) continue;

    if (action.kind === "type" && targetIds.has(action.id)) {
      const sel = action.config.selector?.trim() ?? "";
      if (!sel) {
        out.set(action.id, {
          actionId: action.id,
          selector: sel,
          pageUrl: page.url(),
          domError: "Thiếu selector",
        });
        continue;
      }
      try {
        await page.waitForSelector(sel, { visible: true, timeout: runner.defaultStepTimeoutMs });
        const snap = await page.evaluate((selector) => {
          const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el) return null;
          const labels: string[] = [];
          const fid = el.id;
          if (fid) {
            document.querySelectorAll("label").forEach((l) => {
              if (l.getAttribute("for") === fid) {
                labels.push((l.textContent ?? "").replace(/\s+/g, " ").trim());
              }
            });
          }
          let parent: HTMLElement | null = el.parentElement;
          for (let i = 0; i < 3 && parent; i++, parent = parent.parentElement) {
            const lab = parent.querySelector(":scope > label");
            if (lab) labels.push((lab.textContent ?? "").replace(/\s+/g, " ").trim());
          }
          return {
            tagName: el.tagName.toLowerCase(),
            inputType:
              el instanceof HTMLInputElement
                ? el.type
                : el instanceof HTMLTextAreaElement
                  ? "textarea"
                  : "",
            htmlName: el.getAttribute("name") ?? undefined,
            id: el.id || undefined,
            placeholder: el.getAttribute("placeholder") ?? undefined,
            ariaLabel: el.getAttribute("aria-label") ?? undefined,
            autocomplete: el.getAttribute("autocomplete") ?? undefined,
            labelsText: labels.filter(Boolean).join(" | ") || undefined,
          };
        }, sel);

        if (snap) {
          out.set(action.id, {
            actionId: action.id,
            selector: sel,
            pageUrl: page.url(),
            ...snap,
          });
        } else {
          out.set(action.id, {
            actionId: action.id,
            selector: sel,
            pageUrl: page.url(),
            domError: "Không tìm thấy phần tử trong document",
          });
        }
      } catch (e) {
        out.set(action.id, {
          actionId: action.id,
          selector: sel,
          pageUrl: page.url(),
          domError: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }

    await runStepOnPage(page, action, runner);
  }

  return out;
}
