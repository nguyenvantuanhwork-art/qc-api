import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { getReportSummary } from "./store";

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

/** GET /api/reports/summary?days=14&projectId=uuid */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

reportsRouter.get("/summary", async (req, res) => {
  const daysRaw = (req.query.days as string | undefined) ?? "14";
  const projectRaw = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
  const days = Number(daysRaw);
  const projectId = projectRaw || null;

  if (!Number.isFinite(days)) {
    res.status(400).json({ ok: false, error: "Tham số days không hợp lệ." });
    return;
  }
  if (projectId && !UUID_RE.test(projectId)) {
    res.status(400).json({ ok: false, error: "projectId không phải UUID hợp lệ." });
    return;
  }

  const out = await getReportSummary(req.auth!, {
    days: Number.isFinite(days) ? days : 14,
    projectId,
  });

  if (!out.ok) {
    res.status(403).json({ ok: false, error: out.error });
    return;
  }

  res.json({ ok: true, ...out.summary });
});
