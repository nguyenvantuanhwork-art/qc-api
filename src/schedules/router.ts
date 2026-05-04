import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import {
  createBulkSchedules,
  createSchedule,
  deleteSchedule,
  getScheduleById,
  listSchedules,
  updateSchedule,
} from "./store";
import { isValidCronExpression } from "./cronUtils";

export const schedulesRouter = Router();

schedulesRouter.use(requireAuth);

schedulesRouter.get("/", async (req, res) => {
  const rows = await listSchedules(req.auth!);
  res.json({ ok: true, schedules: rows });
});

schedulesRouter.post("/", async (req, res) => {
  const body = req.body as {
    testCaseId?: unknown;
    name?: unknown;
    cronExpression?: unknown;
    timezone?: unknown;
    enabled?: unknown;
  };
  const testCaseId = typeof body.testCaseId === "string" ? body.testCaseId.trim() : "";
  const name = typeof body.name === "string" ? body.name : "";
  const cronExpression = typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";
  const timezone =
    typeof body.timezone === "string" && body.timezone.trim()
      ? body.timezone.trim()
      : "Asia/Ho_Chi_Minh";
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

  if (!testCaseId || !cronExpression) {
    res.status(400).json({ ok: false, error: "Thiếu testCaseId hoặc cronExpression." });
    return;
  }
  if (!isValidCronExpression(cronExpression, timezone)) {
    res.status(400).json({ ok: false, error: "Biểu thức cron hoặc múi giờ không hợp lệ." });
    return;
  }

  const row = await createSchedule(req.auth!, {
    testCaseId,
    name: name || "Lịch chạy",
    cronExpression,
    timezone,
    enabled,
  });
  if (!row) {
    res.status(404).json({ ok: false, error: "Không tạo được lịch (thiếu quyền hoặc test case không tồn tại)." });
    return;
  }
  res.status(201).json({ ok: true, schedule: row });
});

schedulesRouter.post("/bulk", async (req, res) => {
  const body = req.body as {
    testCaseIds?: unknown;
    namePrefix?: unknown;
    cronExpression?: unknown;
    timezone?: unknown;
    enabled?: unknown;
    staggerSeconds?: unknown;
  };
  const idsRaw = body.testCaseIds;
  const testCaseIds = Array.isArray(idsRaw)
    ? idsRaw.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
  const namePrefix = typeof body.namePrefix === "string" ? body.namePrefix : "";
  const cronExpression =
    typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";
  const timezone =
    typeof body.timezone === "string" && body.timezone.trim()
      ? body.timezone.trim()
      : "Asia/Ho_Chi_Minh";
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  const staggerSeconds =
    typeof body.staggerSeconds === "number" && Number.isFinite(body.staggerSeconds)
      ? body.staggerSeconds
      : Number.parseInt(String(body.staggerSeconds ?? "0"), 10) || 0;

  if (testCaseIds.length === 0 || !cronExpression) {
    res.status(400).json({ ok: false, error: "Thiếu testCaseIds hoặc cronExpression." });
    return;
  }
  if (staggerSeconds < 0 || staggerSeconds > 86_400) {
    res.status(400).json({ ok: false, error: "staggerSeconds phải từ 0 đến 86400 (1 ngày)." });
    return;
  }
  if (!isValidCronExpression(cronExpression, timezone)) {
    res.status(400).json({ ok: false, error: "Biểu thức cron hoặc múi giờ không hợp lệ." });
    return;
  }

  const rows = await createBulkSchedules(req.auth!, {
    testCaseIds,
    namePrefix,
    cronExpression,
    timezone,
    enabled,
    staggerSeconds,
  });
  if (rows.length === 0) {
    res.status(404).json({
      ok: false,
      error: "Không tạo được lịch (thiếu quyền, testcase không tồn tại, hoặc cron không hợp lệ).",
    });
    return;
  }
  res.status(201).json({ ok: true, schedules: rows });
});

schedulesRouter.put("/:scheduleId", async (req, res) => {
  const scheduleId = String(req.params.scheduleId ?? "").trim();
  if (!scheduleId) {
    res.status(400).json({ ok: false, error: "Thiếu scheduleId." });
    return;
  }
  const existing = await getScheduleById(scheduleId);
  if (!existing) {
    res.status(404).json({ ok: false, error: "Không tìm thấy lịch." });
    return;
  }
  const body = req.body as Partial<{
    name: string;
    cronExpression: string;
    timezone: string;
    enabled: boolean;
  }>;
  const patch: Partial<{ name: string; cronExpression: string; timezone: string; enabled: boolean }> =
    {};
  if (body.name !== undefined) patch.name = String(body.name);
  if (body.cronExpression !== undefined) patch.cronExpression = String(body.cronExpression).trim();
  if (body.timezone !== undefined) patch.timezone = String(body.timezone).trim();
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);

  const mergedCron = patch.cronExpression ?? existing.cronExpression;
  const mergedTz = patch.timezone ?? existing.timezone;
  if (patch.cronExpression !== undefined || patch.timezone !== undefined) {
    if (!isValidCronExpression(mergedCron, mergedTz)) {
      res.status(400).json({ ok: false, error: "Cron hoặc múi giờ không hợp lệ." });
      return;
    }
  }

  const row = await updateSchedule(req.auth!, scheduleId, patch);
  if (!row) {
    res.status(404).json({ ok: false, error: "Không tìm thấy lịch hoặc không có quyền." });
    return;
  }
  res.json({ ok: true, schedule: row });
});

schedulesRouter.delete("/:scheduleId", async (req, res) => {
  const scheduleId = String(req.params.scheduleId ?? "").trim();
  if (!scheduleId) {
    res.status(400).json({ ok: false, error: "Thiếu scheduleId." });
    return;
  }
  const ok = await deleteSchedule(req.auth!, scheduleId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "Không tìm thấy lịch hoặc không có quyền." });
    return;
  }
  res.json({ ok: true });
});
