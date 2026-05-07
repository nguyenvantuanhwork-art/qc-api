import { Router } from "express";
import { getPool } from "../db";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { loadAppSettings, upsertAppSettings } from "./store";

export const systemRouter = Router();

/** Công khai: banner + có cho đăng ký hay không — dùng trang đăng nhập. */
systemRouter.get("/public-config", async (_req, res) => {
  try {
    const s = await loadAppSettings(getPool());
    res.json({
      ok: true,
      registrationOpen: s.registrationOpen,
      maintenanceBanner: s.maintenanceBanner,
    });
  } catch (e) {
    console.error("[system] public-config", e);
    res.status(500).json({ ok: false, error: "Không đọc được cấu hình." });
  }
});

/** Đã đăng nhập: xem cài đặt hệ thống (chuẩn bị chỉnh nếu admin). */
systemRouter.get("/settings", requireAuth, async (_req, res) => {
  try {
    const s = await loadAppSettings(getPool());
    res.json({ ok: true, settings: s });
  } catch (e) {
    console.error("[system] get settings", e);
    res.status(500).json({ ok: false, error: "Không đọc được cài đặt." });
  }
});

systemRouter.put("/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const raw = req.body as { registrationOpen?: unknown; maintenanceBanner?: unknown };
    const patch: { registrationOpen?: boolean; maintenanceBanner?: string | null } = {};
    if (typeof raw.registrationOpen === "boolean") {
      patch.registrationOpen = raw.registrationOpen;
    }
    if (typeof raw.maintenanceBanner === "string") {
      patch.maintenanceBanner = raw.maintenanceBanner;
    }
    const s = await upsertAppSettings(getPool(), patch);
    res.json({ ok: true, settings: s });
  } catch (e) {
    console.error("[system] put settings", e);
    res.status(500).json({ ok: false, error: "Không lưu được cài đặt." });
  }
});
