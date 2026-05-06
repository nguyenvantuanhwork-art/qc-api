import { Router } from "express";
import { listActions, createAction, updateAction, deleteAction, reorderActions } from "./store";
import type { ActionKind, ActionConfig } from "./types";
import { handleAiFillTypeValues } from "../ai/fillAction";
import { getPool } from "../db";
import { requireAuth } from "../auth/middleware";
import { assertTestCaseAccess } from "../auth/access";
import { executeTestCaseRun, requestCancelActiveRun } from "./executeRun";

type TcParams = { testCaseId: string; actionId?: string };

export const testCaseRouter = Router({ mergeParams: true });

testCaseRouter.use(requireAuth);
testCaseRouter.use(async (req, res, next) => {
  const testCaseId = String(req.params.testCaseId ?? "").trim();
  if (!testCaseId) {
    res.status(400).json({ ok: false, error: "Thiếu testCaseId" });
    return;
  }
  const auth = req.auth!;
  const allowed = await assertTestCaseAccess(getPool(), auth, testCaseId);
  if (!allowed) {
    res.status(404).json({ ok: false, error: "Không tìm thấy test case" });
    return;
  }
  next();
});

testCaseRouter.get("/actions", async (req, res) => {
  const { testCaseId } = req.params as TcParams;
  res.json({ ok: true, actions: await listActions(testCaseId) });
});

testCaseRouter.post("/actions", async (req, res) => {
  const { testCaseId } = req.params as TcParams;
  const body = req.body as {
    name?: unknown;
    kind?: unknown;
    order?: unknown;
    enabled?: unknown;
    config?: unknown;
    expectation?: unknown;
  };

  const config = (body.config ?? {}) as ActionConfig;
  const name = typeof body.name === "string" ? body.name : "";
  const order = typeof body.order === "number" ? body.order : undefined;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
  const expectation = typeof body.expectation === "string" ? body.expectation : undefined;

  const { action, error } = await createAction(testCaseId, {
    name,
    kind: body.kind as ActionKind,
    order,
    enabled,
    config,
    expectation,
  });
  if (error || !action) {
    res.status(400).json({ ok: false, error: error ?? "Tạo thất bại" });
    return;
  }
  res.status(201).json({ ok: true, action });
});

testCaseRouter.put("/actions/:actionId", async (req, res) => {
  const { testCaseId, actionId = "" } = req.params as TcParams;
  const body = req.body as Partial<{
    name: string;
    kind: ActionKind;
    order: number;
    enabled: boolean;
    config: ActionConfig;
    expectation: string;
  }>;

  const { action, error } = await updateAction(testCaseId, actionId, body);
  if (error) {
    const status = error === "Không tìm thấy hành động" ? 404 : 400;
    res.status(status).json({ ok: false, error });
    return;
  }
  res.json({ ok: true, action });
});

testCaseRouter.delete("/actions/:actionId", async (req, res) => {
  const { testCaseId, actionId = "" } = req.params as TcParams;
  const ok = await deleteAction(testCaseId, actionId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "Không tìm thấy hành động" });
    return;
  }
  res.json({ ok: true });
});

testCaseRouter.put("/actions-order", async (req, res) => {
  const { testCaseId } = req.params as TcParams;
  const orderedIds = (req.body as { orderedIds?: unknown })?.orderedIds;
  if (!Array.isArray(orderedIds) || !orderedIds.every((x) => typeof x === "string")) {
    res.status(400).json({ ok: false, error: "Body cần { orderedIds: string[] }" });
    return;
  }
  const result = await reorderActions(testCaseId, orderedIds as string[]);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, actions: await listActions(testCaseId) });
});

testCaseRouter.post("/ai/fill", handleAiFillTypeValues);

testCaseRouter.post("/run/cancel", async (req, res) => {
  const { testCaseId } = req.params as TcParams;
  const stopped = requestCancelActiveRun(testCaseId);
  if (!stopped) {
    res.status(404).json({ ok: false, error: "Không có tiến trình đang chạy." });
    return;
  }
  res.json({ ok: true });
});

testCaseRouter.post("/run", async (req, res) => {
  const { testCaseId } = req.params as TcParams;
  const ex = await executeTestCaseRun(testCaseId, req.auth?.userId ?? null);
  if (ex.error?.includes("đang chạy")) {
    res.status(409).json({ ok: false, error: ex.error });
    return;
  }
  if (ex.error === "Chưa có hành động nào để chạy.") {
    res.status(400).json({ ok: false, error: ex.error });
    return;
  }
  if (ex.result?.cancelled) {
    res.json({ ok: false, cancelled: true, result: ex.result });
    return;
  }
  if (!ex.ok || !ex.result) {
    res.status(500).json({ ok: false, error: ex.error ?? "Lỗi chạy test." });
    return;
  }
  res.json({ ok: ex.result.ok, result: ex.result });
});
