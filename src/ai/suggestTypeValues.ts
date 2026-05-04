import { getGeminiClient, geminiErrorMessage } from "../gemini/client";
import type { TestAction } from "../testCaseActions/types";
import type { FieldHint } from "./collectFieldHints";

export type AiFillItem = {
  actionId: string;
  value: string;
  confidence?: number;
  notes?: string;
};

const FILL_SYSTEM_INSTRUCTION =
  "Bạn là trợ lý QA automation (TestFlow, Puppeteer). " +
  "Nhiệm vụ: đề xuất giá trị chuỗi hợp lệ cho các bước «Gõ text» (type) trong kịch bản.\n\n" +
  "Quy tắc bắt buộc:\n" +
  "- Trả về duy nhất một đối tượng JSON hợp lệ, không markdown, không văn bản ngoài JSON.\n" +
  '- Schema: {"fills":[{"actionId":"string","value":"string","confidence":0.95,"notes":"tùy chọn"}]}\n' +
  "- confidence: số từ 0 đến 1 (có thể bỏ qua).\n" +
  "- value: một dòng hoặc chuỗi gọn, phù hợp với page.type (tránh \\n trừ khi thật sự cần).\n" +
  "- Ưu tiên dữ liệu test giả rõ ràng (vd: demo@example.com), không dùng PII thật.\n" +
  "- Bám theo expectation / label / placeholder / name nếu có.\n" +
  "- Phải có đúng một mục trong fills cho mỗi actionId được liệt kê (đủ số actionId, không thiếu không thừa).";

function stripJsonFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/u, "");
  }
  return t.trim();
}

export function buildFillUserPrompt(params: {
  context: string;
  targets: TestAction[];
  fieldHints?: Map<string, FieldHint>;
}): string {
  const blocks = params.targets.map((a) => {
    const sel = a.config.selector?.trim() ?? "";
    const cur = a.config.value !== undefined && a.config.value !== null ? String(a.config.value) : "";
    const hint = params.fieldHints?.get(a.id);
    let dom = "";
    if (hint) {
      dom =
        `\n  (DOM) url: ${hint.pageUrl ?? ""}` +
        (hint.domError ? `\n  (DOM) lỗi: ${hint.domError}` : "") +
        (hint.tagName ? `\n  (DOM) tag: ${hint.tagName} input-type: ${hint.inputType ?? ""}` : "") +
        (hint.labelsText ? `\n  (DOM) labels: ${hint.labelsText}` : "") +
        (hint.placeholder ? `\n  (DOM) placeholder: ${hint.placeholder}` : "") +
        (hint.htmlName ? `\n  (DOM) name: ${hint.htmlName}` : "") +
        (hint.id ? `\n  (DOM) id: ${hint.id}` : "") +
        (hint.ariaLabel ? `\n  (DOM) aria-label: ${hint.ariaLabel}` : "") +
        (hint.autocomplete ? `\n  (DOM) autocomplete: ${hint.autocomplete}` : "");
    }
    return (
      `- actionId: ${a.id}\n` +
      `  tên bước: ${a.name}\n` +
      `  selector: ${sel}\n` +
      `  expectation: ${a.expectation ?? ""}\n` +
      `  giá trị hiện tại: ${cur.trim() ? cur : "(trống)"}` +
      dom
    );
  });

  const ctx = params.context.trim() || "(không có ngữ cảnh bổ sung)";

  return `[Ngữ cảnh test case / dự án]\n${ctx}\n\n` + `[Các bước cần đề xuất value — mỗi actionId dưới đây phải có đúng một phần tử tương ứng trong fills]\n\n` + blocks.join("\n\n");
}

export function parseFillResponseText(raw: string): AiFillItem[] {
  const text = stripJsonFence(raw);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Gemini trả về JSON không parse được.");
  }
  if (!data || typeof data !== "object" || !("fills" in data)) {
    throw new Error('Thiếu trường "fills" trong JSON.');
  }
  const fillsRaw = (data as { fills: unknown }).fills;
  if (!Array.isArray(fillsRaw)) throw new Error("fills phải là mảng.");

  const fills: AiFillItem[] = [];
  for (const item of fillsRaw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const actionId = typeof o.actionId === "string" ? o.actionId : "";
    const value = typeof o.value === "string" ? o.value : "";
    if (!actionId) continue;
    const confidence =
      typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : undefined;
    const notes = typeof o.notes === "string" ? o.notes : undefined;
    fills.push({ actionId, value, confidence, notes });
  }
  if (fills.length === 0) throw new Error("fills rỗng sau khi parse.");
  return fills;
}

function assertCoversAllTargets(fills: AiFillItem[], targets: TestAction[]): void {
  const need = new Set(targets.map((t) => t.id));
  const got = new Set(fills.map((f) => f.actionId));
  const missing = [...need].filter((id) => !got.has(id));
  if (missing.length > 0) {
    throw new Error(`Thiếu đề xuất cho actionId: ${missing.join(", ")}`);
  }
  const extra = [...got].filter((id) => !need.has(id));
  if (extra.length > 0) {
    throw new Error(`fills có actionId không hợp lệ: ${extra.join(", ")}`);
  }
}

export async function generateTypeFillSuggestions(params: {
  context: string;
  targets: TestAction[];
  fieldHints?: Map<string, FieldHint>;
  model: string;
}): Promise<{ fills: AiFillItem[]; model: string }> {
  if (params.targets.length === 0) {
    throw new Error("Không có bước type để gợi ý.");
  }

  const userText = buildFillUserPrompt({
    context: params.context,
    targets: params.targets,
    fieldHints: params.fieldHints,
  });

  let text: string;
  try {
    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: params.model,
      contents: userText,
      config: {
        systemInstruction: FILL_SYSTEM_INSTRUCTION,
        temperature: 0.25,
        maxOutputTokens: 2048,
      },
    });
    text = response.text?.trim() ?? "";
  } catch (e) {
    throw new Error(geminiErrorMessage(e));
  }

  if (!text) {
    throw new Error("Gemini không trả về nội dung (model, quota hoặc nội dung bị chặn).");
  }

  const fills = parseFillResponseText(text);
  assertCoversAllTargets(fills, params.targets);
  return { fills, model: params.model };
}
