import { Router } from "express";
import bcrypt from "bcryptjs";
import { getPool } from "../db";
import { signToken } from "./jwt";
import { requireAuth } from "./middleware";

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const body = req.body as { username?: unknown; password?: unknown };
  const usernameRaw = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (usernameRaw.length < 3) {
    res.status(400).json({ ok: false, error: "Username tối thiểu 3 ký tự." });
    return;
  }
  if (password.length < 4) {
    res.status(400).json({ ok: false, error: "Mật khẩu tối thiểu 4 ký tự." });
    return;
  }

  const pool = getPool();
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query<{ id: string; username: string; role: string }>(
      `insert into users(username, password_hash, role) values ($1, $2, 'user')
       returning id::text as id, username, role`,
      [usernameRaw, hash],
    );
    const row = r.rows[0]!;
    const role = row.role === "admin" ? "admin" : "user";
    const token = signToken(row.id, row.username, role);
    res.status(201).json({
      ok: true,
      token,
      user: { id: row.id, username: row.username, role },
    });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ ok: false, error: "Username đã tồn tại." });
      return;
    }
    throw e;
  }
});

authRouter.post("/login", async (req, res) => {
  const body = req.body as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    res.status(400).json({ ok: false, error: "Thiếu username hoặc password." });
    return;
  }

  const pool = getPool();
  const r = await pool.query<{
    id: string;
    username: string;
    password_hash: string;
    role: string;
  }>(`select id::text as id, username, password_hash, role from users where username = $1`, [username]);

  const row = r.rows[0];
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    res.status(401).json({ ok: false, error: "Sai username hoặc mật khẩu." });
    return;
  }

  const role = row.role === "admin" ? "admin" : "user";
  const token = signToken(row.id, row.username, role);
  res.json({
    ok: true,
    token,
    user: { id: row.id, username: row.username, role },
  });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const auth = req.auth!;
  const pool = getPool();
  const r = await pool.query<{ id: string; username: string; role: string }>(
    `select id::text as id, username, role from users where id = $1`,
    [auth.userId],
  );
  const row = r.rows[0];
  if (!row) {
    res.status(401).json({ ok: false, error: "Tài khoản không còn tồn tại." });
    return;
  }
  res.json({ ok: true, user: row });
});
