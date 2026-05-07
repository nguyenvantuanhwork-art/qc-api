import type { RequestHandler } from "express";
import { getPool } from "../db";
import { verifyToken } from "./jwt";
import type { AuthPayload } from "./types";
import { assertProjectAccess, assertProjectManage, assertFeatureInProject } from "./access";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export type { AuthPayload };

/** Chỉ user có JWT role admin. Luôn dùng sau `requireAuth`. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ ok: false, error: "Cần đăng nhập." });
    return;
  }
  if (auth.role !== "admin") {
    res.status(403).json({ ok: false, error: "Cần quyền quản trị viên." });
    return;
  }
  next();
};

export const requireAuth: RequestHandler = (req, res, next) => {
  const raw = req.headers.authorization?.trim();
  if (!raw?.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ ok: false, error: "Cần đăng nhập (Bearer token)." });
    return;
  }
  const token = raw.slice(7).trim();
  if (!token) {
    res.status(401).json({ ok: false, error: "Token rỗng." });
    return;
  }
  try {
    const p = verifyToken(token);
    req.auth = { userId: p.sub, username: p.username, role: p.role };
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Token không hợp lệ hoặc đã hết hạn." });
  }
};

export const requireProjectAccess: RequestHandler = async (req, res, next) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ ok: false, error: "Cần đăng nhập." });
    return;
  }
  const projectId = String(req.params.projectId ?? "").trim();
  if (!projectId) {
    res.status(400).json({ ok: false, error: "Thiếu projectId" });
    return;
  }
  const ok = await assertProjectAccess(getPool(), auth, projectId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project" });
    return;
  }
  next();
};

export const requireProjectManage: RequestHandler = async (req, res, next) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ ok: false, error: "Cần đăng nhập." });
    return;
  }
  const projectId = String(req.params.projectId ?? "").trim();
  if (!projectId) {
    res.status(400).json({ ok: false, error: "Thiếu projectId" });
    return;
  }
  const ok = await assertProjectManage(getPool(), auth, projectId);
  if (!ok) {
    res.status(403).json({ ok: false, error: "Chỉ chủ dự án hoặc admin mới thực hiện được." });
    return;
  }
  next();
};

export const requireFeatureInProject: RequestHandler = async (req, res, next) => {
  const projectId = String(req.params.projectId ?? "").trim();
  const featureId = String(req.params.featureId ?? "").trim();
  if (!projectId || !featureId) {
    res.status(400).json({ ok: false, error: "Thiếu projectId hoặc featureId" });
    return;
  }
  const ok = await assertFeatureInProject(getPool(), projectId, featureId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "Không tìm thấy feature" });
    return;
  }
  next();
};
