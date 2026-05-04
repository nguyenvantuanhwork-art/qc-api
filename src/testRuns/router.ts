import { Router } from "express";
import { getPool } from "../db";
import { requireAuth } from "../auth/middleware";
import { assertTestCaseAccess } from "../auth/access";
import { getTestRun, listGlobalTestRuns, listTestRuns } from "./store";

export const testRunsRouter = Router();

testRunsRouter.use(requireAuth);

testRunsRouter.get("/run-history", async (req, res) => {
  const auth = req.auth!;
  const limitRaw = (req.query.limit as string | undefined) ?? "50";
  const offsetRaw = (req.query.offset as string | undefined) ?? "0";
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  const runs = await listGlobalTestRuns(
    auth.role === "admin",
    auth.userId,
    Number.isFinite(limit) ? limit : 50,
    Number.isFinite(offset) ? offset : 0,
  );
  res.json({ ok: true, runs });
});

testRunsRouter.get("/test-cases/:testCaseId/runs", async (req, res) => {
  const testCaseId = String(req.params.testCaseId || "").trim();
  const limitRaw = (req.query.limit as string | undefined) ?? "30";
  const limit = Number(limitRaw);
  if (!testCaseId) {
    res.status(400).json({ ok: false, error: "Thiếu testCaseId" });
    return;
  }
  const allowed = await assertTestCaseAccess(getPool(), req.auth!, testCaseId);
  if (!allowed) {
    res.status(404).json({ ok: false, error: "Không tìm thấy test case" });
    return;
  }
  const runs = await listTestRuns(testCaseId, limit);
  res.json({ ok: true, runs });
});

testRunsRouter.get("/test-runs/:runId", async (req, res) => {
  const runId = String(req.params.runId || "").trim();
  if (!runId) {
    res.status(400).json({ ok: false, error: "Thiếu runId" });
    return;
  }
  const run = await getTestRun(runId);
  if (!run) {
    res.status(404).json({ ok: false, error: "Không tìm thấy lịch sử chạy" });
    return;
  }
  const allowed = await assertTestCaseAccess(getPool(), req.auth!, run.testCaseId);
  if (!allowed) {
    res.status(404).json({ ok: false, error: "Không tìm thấy lịch sử chạy" });
    return;
  }
  res.json({ ok: true, run });
});

