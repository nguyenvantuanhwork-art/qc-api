import { Router } from "express";
import { requireAuth } from "../auth/middleware";
import { listNotificationsForUser, markAllNotificationsRead, markNotificationRead } from "./store";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req, res) => {
  const userId = req.auth!.userId;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 40;
  const unreadOnly = req.query.unreadOnly === "1" || req.query.unreadOnly === "true";

  try {
    const { items, unreadCount } = await listNotificationsForUser(userId, { limit, unreadOnly });
    res.json({ ok: true, notifications: items, unreadCount });
  } catch (e) {
    console.error("[GET /api/notifications]", e);
    res.status(500).json({ ok: false, error: "Không tải được thông báo." });
  }
});

notificationsRouter.patch("/:id/read", async (req, res) => {
  const userId = req.auth!.userId;
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    res.status(400).json({ ok: false, error: "Thiếu id." });
    return;
  }
  try {
    const ok = await markNotificationRead(userId, id);
    if (!ok) {
      res.status(404).json({ ok: false, error: "Không tìm thấy thông báo." });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[PATCH /api/notifications/:id/read]", e);
    res.status(500).json({ ok: false, error: "Lỗi cập nhật." });
  }
});

notificationsRouter.post("/read-all", async (req, res) => {
  const userId = req.auth!.userId;
  try {
    await markAllNotificationsRead(userId);
    res.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/notifications/read-all]", e);
    res.status(500).json({ ok: false, error: "Lỗi cập nhật." });
  }
});
