import type { Request, Response } from "express";
import { getGeminiClient, getGeminiModel, geminiErrorMessage } from "../gemini/client";
import { getPool } from "../db";
import { createAction, validateConfig } from "../testCaseActions/store";
import type { ActionConfig, ActionKind, TestAction } from "../testCaseActions/types";
import { mergeProjectSettings } from "../projects/projectSettings";

const KINDS: ReadonlySet<string> = new Set([
  "navigate",
  "click_selector",
  "click_text",
  "type",
  "wait",
]);

const GEN_SYSTEM = `Bạn là trợ lý thiết kế kịch bản kiểm thử tự động (Puppeteer) trong hệ thống TestFlow.
Nhiệm vụ: từ mô tả nghiệp vụ, trả về MỘT object JSON hợp lệ duy nhất (không markdown, không văn bản ngoài JSON).

Schema bắt buộc:
{
  "testCase": {
    "id": "string (bắt buộc, slug: chữ thường, số, dấu gạch - hoặc _, ví dụ tc-dang-nhap-ok)",
    "key": "string tùy chọn (mã ngắn hiển thị, ví dụ TC-LOGIN-01)",
    "name": "string (bắt buộc, tiêu đề ngắn gọn)",
    "description": "string (mô tả mục tiêu, tiền điều kiện, kỳ vọng — ưu tiên tiếng Việt nếu user dùng TV)",
    "status": "active" | "draft" | "deprecated" (mặc định active nếu không chắc),
    "priority": "low" | "medium" | "high" (mặc định medium)
  },
  "actions": [
    {
      "kind": "navigate" | "click_selector" | "click_text" | "type" | "wait",
      "name": "string (tên bước ngắn, tiếng Việt nếu phù hợp)",
      "config": { ... },
      "expectation": "string tùy chọn — điều cần kiểm tra sau bước",
      "enabled": true
    }
  ],
  "notes": "string tùy chọn — gợi ý reviewer hoặc rủi ro"
}

Quy tắc kind và config:
- navigate: config.url là URL đầy đủ hoặc đường dẫn; nếu có defaultBaseUrl trong ngữ cảnh, có thể dùng đường dẫn tương đối (vd /login).
- click_selector: config.selector (CSS), ví dụ button[type="submit"], #login-btn.
- click_text: config.matchText — text hiển thị trên nút/link (không phân biệt hoa thường khi chạy).
- type: config.selector và config.value (chuỗi gõ vào; dữ liệu test giả, không PII thật).
- wait: config.waitMs (số ms, 0–120000).

Thứ tự actions phải là luồng hợp lý: thường bắt đầu bằng navigate nếu cần mở URL. Ít nhất 1 bước nếu có thể.
Nếu prompt chỉ yêu cầu thêm bước cho testcase có sẵn (append), vẫn trả đủ schema nhưng có thể đặt testCase.name/description ngắn phản ánh "bổ sung bước".

Luôn trả JSON parse được bằng JSON.parse.`;

function stripJsonFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/u, "");
  }
  return t.trim();
}

function slugifyId(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 120);
  return s || "tc-ai-draft";
}

function normalizePriority(v: unknown): string {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (t === "low" || t === "high") return t;
  return "medium";
}

function normalizeStatus(v: unknown): string {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (t === "draft" || t === "deprecated") return t;
  return "active";
}

function normalizeKind(v: unknown): ActionKind | null {
  if (typeof v !== "string") return null;
  const k = v.trim();
  if (KINDS.has(k)) return k as ActionKind;
  return null;
}

function coerceConfig(kind: ActionKind, raw: unknown): ActionConfig {
  const o =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  switch (kind) {
    case "navigate":
      return { url: typeof o.url === "string" ? o.url.trim() : "" };
    case "click_selector":
      return { selector: typeof o.selector === "string" ? o.selector.trim() : "" };
    case "click_text":
      return { matchText: typeof o.matchText === "string" ? o.matchText.trim() : "" };
    case "type": {
      let value = "";
      if (typeof o.value === "string") value = o.value;
      else if (o.value != null) value = String(o.value);
      return {
        selector: typeof o.selector === "string" ? o.selector.trim() : "",
        value,
      };
    }
    case "wait": {
      const w = o.waitMs;
      const n = typeof w === "number" && Number.isFinite(w) ? Math.floor(w) : 1000;
      return { waitMs: n };
    }
    default:
      return {};
  }
}

export type AiGeneratedDraft = {
  testCase: {
    id: string;
    key: string | null;
    name: string;
    description: string;
    status: string;
    priority: string;
  };
  actions: Array<{
    kind: ActionKind;
    name: string;
    config: ActionConfig;
    expectation?: string;
    enabled: boolean;
    validationError?: string;
  }>;
  notes?: string;
};

function parseDraftPayload(raw: unknown): AiGeneratedDraft {
  if (!raw || typeof raw !== "object") {
    throw new Error("Phản hồi AI không phải object.");
  }
  const root = raw as Record<string, unknown>;
  const tcIn = root.testCase;
  if (!tcIn || typeof tcIn !== "object") {
    throw new Error('Thiếu "testCase" trong JSON.');
  }
  const t = tcIn as Record<string, unknown>;
  const id = slugifyId(typeof t.id === "string" ? t.id : "");
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name) {
    throw new Error("testCase.name bắt buộc.");
  }
  const key = typeof t.key === "string" && t.key.trim() ? t.key.trim() : null;
  const description = typeof t.description === "string" ? t.description.trim() : "";
  const testCase = {
    id,
    key,
    name,
    description,
    status: normalizeStatus(t.status),
    priority: normalizePriority(t.priority),
  };

  const arr = root.actions;
  if (!Array.isArray(arr)) {
    throw new Error("actions phải là mảng.");
  }

  const actions: AiGeneratedDraft["actions"] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const kind = normalizeKind(a.kind);
    if (!kind) {
      actions.push({
        kind: "wait",
        name: typeof a.name === "string" ? a.name : "bước không hợp lệ",
        config: { waitMs: 0 },
        expectation: "",
        enabled: false,
        validationError: `kind không hợp lệ: ${String(a.kind)}`,
      });
      continue;
    }
    const nameStep = typeof a.name === "string" && a.name.trim() ? a.name.trim() : kind;
    const config = coerceConfig(kind, a.config);
    const err = validateConfig(kind, config);
    const enabled = a.enabled === false ? false : true;
    const expectation = typeof a.expectation === "string" ? a.expectation.trim() : "";
    actions.push({
      kind,
      name: nameStep,
      config,
      expectation,
      enabled: enabled && !err,
      validationError: err ?? undefined,
    });
  }

  if (actions.length === 0) {
    throw new Error("actions rỗng — cần ít nhất một bước hợp lệ.");
  }

  const notes = typeof root.notes === "string" ? root.notes.trim() : undefined;
  return { testCase, actions, notes };
}

export function parseDraftFromModelText(text: string): AiGeneratedDraft {
  const cleaned = stripJsonFence(text);
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error("Gemini trả về JSON không parse được.");
  }
  return parseDraftPayload(data);
}

async function generateDraftWithGemini(userBlock: string): Promise<{ draft: AiGeneratedDraft; model: string }> {
  const model = getGeminiModel();
  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model,
    contents: userBlock,
    config: {
      systemInstruction: GEN_SYSTEM,
      temperature: 0.25,
      maxOutputTokens: 4096,
    },
  });
  const text = response.text?.trim() ?? "";
  if (!text) {
    throw new Error("Gemini không trả về nội dung (model, quota hoặc nội dung bị chặn).");
  }
  const draft = parseDraftFromModelText(text);
  return { draft, model };
}

function collectWarnings(d: AiGeneratedDraft): string[] {
  const w: string[] = [];
  for (const a of d.actions) {
    if (a.validationError) {
      w.push(`${a.name} (${a.kind}): ${a.validationError}`);
    }
    if (a.enabled === false && !a.validationError) {
      w.push(`${a.name}: bước bị tắt.`);
    }
  }
  return w;
}

function assertAppliable(d: AiGeneratedDraft): void {
  const toApply = d.actions.filter((a) => a.enabled && !a.validationError);
  if (toApply.length === 0) {
    throw new Error("Không có bước nào hợp lệ để áp dụng — chỉnh lại bản nháp hoặc tạo lại.");
  }
}

export async function handleTestCaseFromPrompt(req: Request, res: Response): Promise<void> {
  const projectId = String(req.params.projectId ?? "").trim();
  const featureId = String(req.params.featureId ?? "").trim();
  const body = req.body as {
    mode?: unknown;
    prompt?: unknown;
    context?: unknown;
    draft?: unknown;
    appendToTestCaseId?: unknown;
  };

  const mode = body.mode === "apply" ? "apply" : "preview";
  const appendToTestCaseId =
    typeof body.appendToTestCaseId === "string" ? body.appendToTestCaseId.trim() : "";

  const pool = getPool();

  const projRow = await pool.query<{ settings: unknown }>(
    `select settings from projects where id=$1`,
    [projectId],
  );
  const merged = mergeProjectSettings(projRow.rows[0]?.settings ?? {});
  const baseUrl = merged.runner.defaultBaseUrl?.trim() ?? "";

  const featRow = await pool.query<{ name: string; description: string | null }>(
    `select name, description from features where id=$1 and project_id=$2`,
    [featureId, projectId],
  );
  const featureName = featRow.rows[0]?.name ?? "";
  const featureDesc = featRow.rows[0]?.description ?? "";

  try {
    if (mode === "preview") {
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        res.status(400).json({ ok: false, error: "Thiếu prompt." });
        return;
      }
      const extra = typeof body.context === "string" ? body.context.trim() : "";
      const userBlock = [
        `[Dự án / Feature]\nprojectId: ${projectId}\nfeatureId: ${featureId}`,
        `Feature: ${featureName}`,
        featureDesc ? `Mô tả feature: ${featureDesc}` : null,
        baseUrl ? `defaultBaseUrl (ưu tiên cho navigate): ${baseUrl}` : `defaultBaseUrl: (chưa cấu hình — dùng URL đầy đủ trong navigate)`,
        extra ? `[Ngữ cảnh bổ sung từ người dùng]\n${extra}` : null,
        `[Yêu cầu thiết kế testcase]\n${prompt}`,
      ]
        .filter((x) => x !== null)
        .join("\n\n");

      const { draft, model } = await generateDraftWithGemini(userBlock);
      const warnings = collectWarnings(draft);
      res.json({
        ok: true,
        mode: "preview" as const,
        draft,
        warnings,
        model,
      });
      return;
    }

    // apply
    let draft: AiGeneratedDraft;
    if (body.draft && typeof body.draft === "object") {
      draft = parseDraftPayload(body.draft);
    } else {
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        res.status(400).json({ ok: false, error: "Áp dụng cần draft (object) hoặc prompt để tạo lại." });
        return;
      }
      const extra = typeof body.context === "string" ? body.context.trim() : "";
      const userBlock = [
        `[Dự án / Feature]\nprojectId: ${projectId}\nfeatureId: ${featureId}`,
        `Feature: ${featureName}`,
        featureDesc ? `Mô tả feature: ${featureDesc}` : null,
        baseUrl ? `defaultBaseUrl: ${baseUrl}` : null,
        extra ? `[Ngữ cảnh bổ sung]\n${extra}` : null,
        `[Yêu cầu]\n${prompt}`,
      ]
        .filter((x) => x !== null)
        .join("\n\n");
      const gen = await generateDraftWithGemini(userBlock);
      draft = gen.draft;
    }

    assertAppliable(draft);
    const actionsToCreate = draft.actions.filter((a) => a.enabled && !a.validationError);

    if (appendToTestCaseId) {
      const chk = await pool.query(`select id from test_cases where id=$1 and feature_id=$2`, [
        appendToTestCaseId,
        featureId,
      ]);
      if ((chk.rowCount ?? 0) === 0) {
        res.status(404).json({ ok: false, error: "Không tìm thấy test case để thêm bước." });
        return;
      }
      const created: TestAction[] = [];
      for (const a of actionsToCreate) {
        const r = await createAction(appendToTestCaseId, {
          name: a.name,
          kind: a.kind,
          config: a.config,
          expectation: a.expectation,
          enabled: true,
        });
        if (r.error || !r.action) {
          res.status(400).json({ ok: false, error: r.error ?? "Tạo bước thất bại." });
          return;
        }
        created.push(r.action);
      }
      res.status(201).json({
        ok: true,
        mode: "apply" as const,
        appendToTestCaseId,
        actionsCreated: created,
      });
      return;
    }

    const tc = draft.testCase;
    try {
      const ins = await pool.query(
        `insert into test_cases(id, feature_id, key, name, description, status, priority)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, feature_id::text as featureId, key, name, description, status, priority, created_at, updated_at`,
        [tc.id, featureId, tc.key, tc.name, tc.description, tc.status, tc.priority],
      );
      const testCaseRow = ins.rows[0];
      const createdActions: TestAction[] = [];
      for (const a of actionsToCreate) {
        const r = await createAction(tc.id, {
          name: a.name,
          kind: a.kind,
          config: a.config,
          expectation: a.expectation,
          enabled: true,
        });
        if (r.error || !r.action) {
          res.status(500).json({
            ok: false,
            error: `Đã tạo test case nhưng lỗi khi thêm bước: ${r.error ?? ""}`,
          });
          return;
        }
        createdActions.push(r.action);
      }
      res.status(201).json({
        ok: true,
        mode: "apply" as const,
        testCase: testCaseRow,
        actions: createdActions,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key|unique constraint/i.test(msg)) {
        res.status(409).json({
          ok: false,
          error: "ID test case đã tồn tại. Đổi id trong bản nháp (tab Thiết kế) rồi áp dụng lại.",
        });
        return;
      }
      console.error("[api/ai/test-case-from-prompt] insert", msg);
      res.status(500).json({ ok: false, error: msg.length > 400 ? `${msg.slice(0, 400)}…` : msg });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = /GEMINI|parse|Thiếu|Không có/.test(message)
      ? message
      : geminiErrorMessage(err);
    console.error("[api/ai/test-case-from-prompt]", message);
    res.status(400).json({ ok: false, error: wrapped });
  }
}
