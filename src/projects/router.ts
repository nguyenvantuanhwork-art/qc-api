import { Router } from "express";
import { getPool } from "../db";
import { requireAuth, requireProjectAccess, requireProjectManage } from "../auth/middleware";
import { assertProjectAccess, assertProjectManage } from "../auth/access";
import { mergePatchIntoStored, mergeProjectSettings } from "./projectSettings";
import { notifyProjectMemberAdded } from "../notifications/store";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

projectsRouter.get("/", async (req, res) => {
  const pool = getPool();
  const auth = req.auth!;
  const r =
    auth.role === "admin"
      ? await pool.query(
          `select id::text as id, key, name, description, created_at, updated_at
           from projects order by updated_at desc`,
        )
      : await pool.query(
          `select p.id::text as id, p.key, p.name, p.description, p.created_at, p.updated_at
           from projects p
           where p.owner_user_id = $1
              or exists (
                select 1 from project_members pm
                where pm.project_id = p.id and pm.user_id = $1
              )
           order by p.updated_at desc`,
          [auth.userId],
        );
  res.json({ ok: true, projects: r.rows });
});

projectsRouter.post("/", async (req, res) => {
  const body = req.body as { key?: unknown; name?: unknown; description?: unknown };
  const key = typeof body.key === "string" ? body.key.trim() : null;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";

  if (!name) {
    res.status(400).json({ ok: false, error: "Thiếu name" });
    return;
  }

  const pool = getPool();
  const r = await pool.query(
    `insert into projects(key, name, description, owner_user_id)
     values ($1, $2, $3, $4::uuid)
     returning id::text as id, key, name, description, created_at, updated_at`,
    [key, name, description, req.auth!.userId],
  );
  res.status(201).json({ ok: true, project: r.rows[0] });
});

projectsRouter.get("/:projectId/members", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const auth = req.auth!;
  const projectId = String(req.params.projectId ?? "");

  const canManage = await assertProjectManage(pool, auth, projectId);

  const ownerRows = await pool.query<{ userId: string; username: string; role: string }>(
    `select u.id::text as "userId", u.username, 'owner'::text as role
     from projects p
     join users u on u.id = p.owner_user_id
     where p.id = $1`,
    [projectId],
  );

  const memberRows = await pool.query<{ userId: string; username: string; role: string }>(
    `select u.id::text as "userId", u.username, 'member'::text as role
     from project_members pm
     join users u on u.id = pm.user_id
     where pm.project_id = $1
     order by u.username`,
    [projectId],
  );

  const members = [...ownerRows.rows, ...memberRows.rows];
  res.json({ ok: true, members, canManage });
});

projectsRouter.post("/:projectId/members", requireProjectAccess, requireProjectManage, async (req, res) => {
  const pool = getPool();
  const projectId = String(req.params.projectId ?? "");
  const body = req.body as { username?: unknown };
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  if (!username) {
    res.status(400).json({ ok: false, error: "Thiếu username." });
    return;
  }

  const ownerR = await pool.query<{ owner_user_id: string }>(
    `select owner_user_id::text as owner_user_id from projects where id = $1`,
    [projectId],
  );
  const ownerId = ownerR.rows[0]?.owner_user_id;
  if (!ownerId) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project." });
    return;
  }

  const userR = await pool.query<{ id: string }>(
    `select id::text as id from users where username = $1`,
    [username],
  );
  const newMemberId = userR.rows[0]?.id;
  if (!newMemberId) {
    res.status(404).json({ ok: false, error: "Không tìm thấy người dùng với username này." });
    return;
  }

  if (newMemberId === ownerId) {
    res.status(400).json({ ok: false, error: "Người này đã là chủ dự án." });
    return;
  }

  let projectName = "Dự án";
  const pn = await pool.query<{ name: string }>(`select name from projects where id = $1`, [projectId]);
  projectName = pn.rows[0]?.name ?? projectName;

  try {
    await pool.query(
      `insert into project_members(project_id, user_id) values ($1, $2::uuid)`,
      [projectId, newMemberId],
    );
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ ok: false, error: "Người này đã là thành viên dự án." });
      return;
    }
    throw e;
  }

  await notifyProjectMemberAdded({
    userId: newMemberId,
    projectId,
    projectName,
    invitedByUsername: req.auth!.username,
  });

  const memberRows = await pool.query<{ userId: string; username: string; role: string }>(
    `select u.id::text as "userId", u.username, 'member'::text as role
     from project_members pm
     join users u on u.id = pm.user_id
     where pm.project_id = $1
     order by u.username`,
    [projectId],
  );
  const ownerRows = await pool.query<{ userId: string; username: string; role: string }>(
    `select u.id::text as "userId", u.username, 'owner'::text as role
     from projects p
     join users u on u.id = p.owner_user_id
     where p.id = $1`,
    [projectId],
  );
  res.status(201).json({ ok: true, members: [...ownerRows.rows, ...memberRows.rows] });
});

projectsRouter.delete(
  "/:projectId/members/:memberUserId",
  requireProjectAccess,
  requireProjectManage,
  async (req, res) => {
    const pool = getPool();
    const projectId = String(req.params.projectId ?? "");
    const memberUserId = String(req.params.memberUserId ?? "").trim();
    if (!memberUserId) {
      res.status(400).json({ ok: false, error: "Thiếu memberUserId." });
      return;
    }

    const ownerR = await pool.query<{ owner_user_id: string }>(
      `select owner_user_id::text as owner_user_id from projects where id = $1`,
      [projectId],
    );
    const ownerId = ownerR.rows[0]?.owner_user_id;
    if (memberUserId === ownerId) {
      res.status(400).json({ ok: false, error: "Không thể gỡ chủ dự án. Hãy chuyển quyền hoặc xóa dự án." });
      return;
    }

    const del = await pool.query(`delete from project_members where project_id=$1 and user_id=$2::uuid`, [
      projectId,
      memberUserId,
    ]);
    if ((del.rowCount ?? 0) === 0) {
      res.status(404).json({ ok: false, error: "Không tìm thấy thành viên trong dự án." });
      return;
    }
    res.json({ ok: true });
  },
);

projectsRouter.get("/:projectId/settings", requireProjectAccess, async (req, res) => {
  const projectId = String(req.params.projectId ?? "");
  const pool = getPool();
  const r = await pool.query<{ settings: unknown }>(`select settings from projects where id = $1`, [projectId]);
  if (r.rowCount === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project" });
    return;
  }
  const canManage = await assertProjectManage(pool, req.auth!, projectId);
  res.json({
    ok: true,
    settings: mergeProjectSettings(r.rows[0].settings),
    canManage,
  });
});

/** Danh sách test case trong dự án (cho UI lên lịch — không phụ thuộc testcase đang chọn). */
projectsRouter.get("/:projectId/schedule-test-cases", requireProjectAccess, async (req, res) => {
  const projectId = String(req.params.projectId ?? "");
  const pool = getPool();
  const q = await pool.query<{
    id: string;
    testCaseName: string;
    featureId: string;
    featureName: string;
  }>(
    `
    select tc.id::text as id,
           tc.name as "testCaseName",
           f.id::text as "featureId",
           f.name as "featureName"
    from test_cases tc
    inner join features f on f.id = tc.feature_id
    where f.project_id = $1::uuid
    order by f.name asc, tc.name asc
  `,
    [projectId],
  );
  res.json({ ok: true, testCases: q.rows });
});

projectsRouter.put("/:projectId/settings", requireProjectAccess, requireProjectManage, async (req, res) => {
  const projectId = String(req.params.projectId ?? "");
  const pool = getPool();
  const cur = await pool.query<{ settings: unknown }>(`select settings from projects where id = $1`, [projectId]);
  if (cur.rowCount === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project" });
    return;
  }
  const merged = mergePatchIntoStored(cur.rows[0].settings, req.body);
  if (!merged.ok) {
    res.status(400).json({ ok: false, error: merged.error });
    return;
  }
  const up = await pool.query<{ settings: unknown }>(
    `update projects set settings = $2::jsonb, updated_at = now() where id = $1 returning settings`,
    [projectId, JSON.stringify(merged.stored)],
  );
  res.json({
    ok: true,
    settings: mergeProjectSettings(up.rows[0].settings),
  });
});

projectsRouter.get("/:projectId", async (req, res) => {
  const projectId = String(req.params.projectId ?? "");
  const ok = await assertProjectAccess(getPool(), req.auth!, projectId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project" });
    return;
  }
  const pool = getPool();
  const r = await pool.query(
    `select id::text as id, key, name, description, created_at, updated_at
     from projects where id=$1`,
    [projectId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project" });
    return;
  }
  res.json({ ok: true, project: r.rows[0] });
});

projectsRouter.put("/:projectId", async (req, res) => {
  const projectId = String(req.params.projectId ?? "");
  const ok = await assertProjectManage(getPool(), req.auth!, projectId);
  if (!ok) {
    res.status(403).json({ ok: false, error: "Chỉ chủ dự án hoặc admin mới sửa được dự án." });
    return;
  }
  const body = req.body as Partial<{ key: string; name: string; description: string }>;
  const key = body.key !== undefined ? String(body.key).trim() : undefined;
  const name = body.name !== undefined ? String(body.name).trim() : undefined;
  const description =
    body.description !== undefined ? String(body.description).trim() : undefined;

  const pool = getPool();
  const r = await pool.query(
    `update projects
     set key = coalesce($2, key),
         name = coalesce($3, name),
         description = coalesce($4, description),
         updated_at = now()
     where id=$1
     returning id::text as id, key, name, description, created_at, updated_at`,
    [projectId, key ?? null, name ?? null, description ?? null],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project" });
    return;
  }
  res.json({ ok: true, project: r.rows[0] });
});

projectsRouter.delete("/:projectId", async (req, res) => {
  const projectId = String(req.params.projectId ?? "");
  const ok = await assertProjectManage(getPool(), req.auth!, projectId);
  if (!ok) {
    res.status(403).json({ ok: false, error: "Chỉ chủ dự án hoặc admin mới xóa được dự án." });
    return;
  }
  const pool = getPool();
  const r = await pool.query(`delete from projects where id=$1`, [projectId]);
  if ((r.rowCount ?? 0) === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy project" });
    return;
  }
  res.json({ ok: true });
});
