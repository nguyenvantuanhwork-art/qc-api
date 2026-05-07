import type { Request, Response } from "express";
import puppeteer from "puppeteer";
import { getPool } from "../db";
import { listActions, updateAction } from "../testCaseActions/store";
import type { TestAction } from "../testCaseActions/types";
import { getProjectIdForTestCase } from "../testCaseActions/projectContext";
import { mergeProjectSettings } from "../projects/projectSettings";
import { getGeminiModel } from "../gemini/client";
import { collectFieldHintsForActions } from "./collectFieldHints";
import type { AiFillItem } from "./suggestTypeValues";
import { generateTypeFillSuggestions } from "./suggestTypeValues";

function parseClientFills(raw: unknown): AiFillItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AiFillItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    if (typeof o.actionId !== "string" || typeof o.value !== "string") return null;
    out.push({
      actionId: o.actionId,
      value: o.value,
      confidence: typeof o.confidence === "number" ? o.confidence : undefined,
      notes: typeof o.notes === "string" ? o.notes : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

function resolveTargets(
  sorted: TestAction[],
  opts: {
    onlyEmpty: boolean;
    actionIdsFilter: Set<string> | null;
  },
): TestAction[] {
  let targets = sorted.filter(
    (a) => a.enabled && (a.kind === "type" || a.kind === "type_id" || a.kind === "type_name" || a.kind === "type_xpath"),
  );
  if (opts.actionIdsFilter) {
    targets = targets.filter((a) => opts.actionIdsFilter!.has(a.id));
  }
  if (opts.onlyEmpty) {
    targets = targets.filter((a) => {
      const v = a.config.value;
      return v === undefined || v === null || String(v).trim() === "";
    });
  }
  return targets;
}

async function applyFills(
  testCaseId: string,
  fills: AiFillItem[],
  allowedIds: Set<string>,
): Promise<{ appliedActionIds: string[]; actions: TestAction[] }> {
  const latest = await listActions(testCaseId);
  const byId = new Map(latest.map((a) => [a.id, a] as const));
  const appliedActionIds: string[] = [];
  for (const f of fills) {
    if (!allowedIds.has(f.actionId)) continue;
    const cur = byId.get(f.actionId);
    if (
      !cur ||
      (cur.kind !== "type" && cur.kind !== "type_id" && cur.kind !== "type_name" && cur.kind !== "type_xpath")
    ) {
      continue;
    }
    const { action, error } = await updateAction(testCaseId, f.actionId, {
      config: { ...cur.config, value: f.value },
    });
    if (!error && action) {
      appliedActionIds.push(f.actionId);
      byId.set(f.actionId, action);
    }
  }
  const actions = await listActions(testCaseId);
  return { appliedActionIds, actions };
}

/**
 * POST /api/test-cases/:testCaseId/ai/fill
 *
 * Body:
 * - context?: string — ngữ cảnh (portal gửi buildTestCaseContext()).
 * - mode?: "preview" | "apply"
 * - useDomContext?: boolean — chạy Puppeteer để đọc label/placeholder (chậm).
 * - onlyEmpty?: boolean — mặc true: chỉ bước type đang trống.
 * - actionIds?: string[] — giới hạn bước.
 * - fills?: AiFillItem[] — khi mode=apply, nếu có thì áp dụng trực tiếp (không gọi lại LLM).
 */
export async function handleAiFillTypeValues(req: Request, res: Response): Promise<void> {
  const { testCaseId } = req.params as { testCaseId: string };
  const body = req.body as {
    context?: unknown;
    mode?: unknown;
    useDomContext?: unknown;
    actionIds?: unknown;
    onlyEmpty?: unknown;
    fills?: unknown;
  };

  const context = typeof body.context === "string" ? body.context.trim() : "";
  const mode = body.mode === "apply" ? "apply" : "preview";
  const useDomContext = Boolean(body.useDomContext);
  const onlyEmpty = body.onlyEmpty === false ? false : true;
  const actionIdsFilter =
    Array.isArray(body.actionIds) && body.actionIds.every((x) => typeof x === "string")
      ? new Set(body.actionIds as string[])
      : null;

  const pool = getPool();
  const projId = await getProjectIdForTestCase(testCaseId);
  const projRow = projId
    ? await pool.query<{ settings: unknown }>(`select settings from projects where id=$1`, [projId])
    : null;
  const projectMerged = mergeProjectSettings(projRow?.rows[0]?.settings ?? {});

  const sorted = [...(await listActions(testCaseId))].sort((a, b) => a.order - b.order);
  const targets = resolveTargets(sorted, { onlyEmpty, actionIdsFilter });

  if (targets.length === 0) {
    res.status(400).json({
      ok: false,
      error: "Không có bước «Gõ text» phù hợp (đã có giá trị, bị tắt, hoặc không khớp actionIds).",
    });
    return;
  }

  const allowAiFillWithoutGemini = mode === "apply" && parseClientFills(body.fills) !== null;
  if (!projectMerged.ai.enabled && !allowAiFillWithoutGemini) {
    res.status(403).json({
      ok: false,
      error: "AI đã tắt trong cài đặt dự án này.",
    });
    return;
  }

  const targetIdSet = new Set(targets.map((t) => t.id));

  if (mode === "apply") {
    const clientFills = parseClientFills(body.fills);
    if (clientFills) {
      const allowed = targetIdSet;
      const ids = new Set(clientFills.map((f) => f.actionId));
      const missing = [...allowed].filter((id) => !ids.has(id));
      if (missing.length > 0) {
        res.status(400).json({
          ok: false,
          error: `Thiếu actionId trong fills: ${missing.join(", ")}`,
        });
        return;
      }
      const extra = [...ids].filter((id) => !allowed.has(id));
      if (extra.length > 0) {
        res.status(400).json({
          ok: false,
          error: `fills chứa actionId không được phép: ${extra.join(", ")}`,
        });
        return;
      }
      if (new Set(clientFills.map((f) => f.actionId)).size !== clientFills.length) {
        res.status(400).json({ ok: false, error: "fills trùng actionId." });
        return;
      }

      try {
        const { appliedActionIds, actions } = await applyFills(testCaseId, clientFills, targetIdSet);
        res.json({
          ok: true,
          mode: "apply" as const,
          fills: clientFills,
          appliedActionIds,
          actions,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[api/ai/fill:apply]", message);
        res.status(500).json({ ok: false, error: message });
      }
      return;
    }
  }

  let fieldHints: Map<string, import("./collectFieldHints").FieldHint> | undefined;
  if (useDomContext) {
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    try {
      browser = await puppeteer.launch({
        headless: projectMerged.runner.headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      const page = await browser.newPage();
      await page.setViewport({
        width: projectMerged.runner.viewportWidth,
        height: projectMerged.runner.viewportHeight,
      });
      fieldHints = await collectFieldHintsForActions(page, sorted, targetIdSet, projectMerged.runner);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(422).json({
        ok: false,
        error: `Không thu thập được DOM (kiểm tra các bước navigate trước đó): ${msg}`,
      });
      return;
    } finally {
      await browser?.close();
    }
  }

  try {
    const model = getGeminiModel();
    const { fills, model: usedModel } = await generateTypeFillSuggestions({
      context,
      targets,
      fieldHints,
      model,
    });

    if (mode === "preview") {
      res.json({
        ok: true,
        mode: "preview" as const,
        fills,
        model: usedModel,
      });
      return;
    }

    const { appliedActionIds, actions } = await applyFills(testCaseId, fills, targetIdSet);
    res.json({
      ok: true,
      mode: "apply" as const,
      fills,
      appliedActionIds,
      actions,
      model: usedModel,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[api/ai/fill]", message);
    res.status(500).json({ ok: false, error: message });
  }
}
