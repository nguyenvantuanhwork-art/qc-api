import { Router } from "express";
import { getPool } from "../db";
import { requireAuth, requireProjectAccess, requireProjectManage } from "../auth/middleware";
import {
  assertGroupInProject,
  assertGroupViewAllowed,
  assertProjectAccess,
  assertProjectManage,
} from "../auth/access";
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
    // Dọn các nhóm thuộc dự án: gỡ member khỏi group nếu có
    await pool.query(
      `
      delete from project_group_members gm
      using project_groups g
      where gm.group_id = g.id
        and g.project_id = $1::uuid
        and gm.user_id = $2::uuid
    `,
      [projectId, memberUserId],
    );
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

// ---------- project groups ----------
type GroupParams = { projectId: string; groupId?: string };

projectsRouter.get("/:projectId/groups", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const { projectId } = req.params as GroupParams;
  const canManage = await assertProjectManage(pool, req.auth!, projectId);
  const r = await pool.query<{
    id: string;
    name: string;
    description: string;
    memberCount: string;
    featureCount: string;
    testCaseCount: string;
    createdAt: string;
    updatedAt: string;
    canUseGroupTestScope: boolean;
  }>(
    `
    select g.id::text as id,
           g.name,
           g.description,
           (select count(*)::int::text from project_group_members gm where gm.group_id = g.id) as "memberCount",
           (select count(*)::int::text from project_group_feature_assignments ga where ga.group_id = g.id) as "featureCount",
           (select count(*)::int::text from project_group_test_case_assignments ta where ta.group_id = g.id) as "testCaseCount",
           g.created_at::text as "createdAt",
           g.updated_at::text as "updatedAt",
           (
             $2::boolean
             or exists (
               select 1 from project_group_members gm
               where gm.group_id = g.id and gm.user_id = $3::uuid
             )
           ) as "canUseGroupTestScope"
    from project_groups g
    where g.project_id = $1::uuid
    order by g.updated_at desc, g.name asc
  `,
    [projectId, canManage, req.auth!.userId],
  );
  res.json({ ok: true, groups: r.rows, canManage });
});

projectsRouter.post("/:projectId/groups", requireProjectAccess, requireProjectManage, async (req, res) => {
  const pool = getPool();
  const { projectId } = req.params as GroupParams;
  const body = req.body as { name?: unknown; description?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!name) {
    res.status(400).json({ ok: false, error: "Thiếu name" });
    return;
  }
  try {
    const r = await pool.query(
      `insert into project_groups(project_id, name, description)
       values ($1::uuid, $2, $3)
       returning id::text as id, project_id::text as "projectId", name, description, created_at, updated_at`,
      [projectId, name, description],
    );
    res.status(201).json({ ok: true, group: r.rows[0] });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ ok: false, error: "Tên nhóm đã tồn tại trong dự án." });
      return;
    }
    throw e;
  }
});

projectsRouter.put("/:projectId/groups/:groupId", requireProjectAccess, requireProjectManage, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  const ok = await assertGroupInProject(pool, projectId, groupId);
  if (!ok) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  const body = req.body as { name?: unknown; description?: unknown };
  const name = body.name !== undefined ? String(body.name).trim() : undefined;
  const description = body.description !== undefined ? String(body.description).trim() : undefined;
  if (name !== undefined && !name) {
    res.status(400).json({ ok: false, error: "name không hợp lệ" });
    return;
  }
  try {
    const r = await pool.query(
      `update project_groups
       set name = coalesce($3, name),
           description = coalesce($4, description),
           updated_at = now()
       where id=$1::uuid and project_id=$2::uuid
       returning id::text as id, project_id::text as "projectId", name, description, created_at, updated_at`,
      [groupId, projectId, name ?? null, description ?? null],
    );
    res.json({ ok: true, group: r.rows[0] });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ ok: false, error: "Tên nhóm đã tồn tại trong dự án." });
      return;
    }
    throw e;
  }
});

projectsRouter.delete("/:projectId/groups/:groupId", requireProjectAccess, requireProjectManage, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  const del = await pool.query(`delete from project_groups where id=$1::uuid and project_id=$2::uuid`, [
    groupId,
    projectId,
  ]);
  if ((del.rowCount ?? 0) === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  res.json({ ok: true });
});

projectsRouter.get("/:projectId/groups/:groupId/members", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  if (!(await assertGroupInProject(pool, projectId, groupId))) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  if (!(await assertGroupViewAllowed(pool, req.auth!, projectId, groupId))) {
    res.status(403).json({ ok: false, error: "Bạn không có quyền xem nhóm này." });
    return;
  }
  const canManage = await assertProjectManage(pool, req.auth!, projectId);
  const rows = await pool.query<{ userId: string; username: string; createdAt: string }>(
    `
    select u.id::text as "userId", u.username, gm.created_at::text as "createdAt"
    from project_group_members gm
    join users u on u.id = gm.user_id
    where gm.group_id = $1::uuid
    order by u.username asc
  `,
    [groupId],
  );
  res.json({ ok: true, members: rows.rows, canManage });
});

projectsRouter.post(
  "/:projectId/groups/:groupId/members",
  requireProjectAccess,
  requireProjectManage,
  async (req, res) => {
    const pool = getPool();
    const { projectId, groupId = "" } = req.params as GroupParams;
    if (!groupId.trim()) {
      res.status(400).json({ ok: false, error: "Thiếu groupId" });
      return;
    }
    const ok = await assertGroupInProject(pool, projectId, groupId);
    if (!ok) {
      res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
      return;
    }
    const body = req.body as { username?: unknown; userId?: unknown };
    const userIdRaw = typeof body.userId === "string" ? body.userId.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";

    let userId: string | null = userIdRaw || null;
    if (!userId && username) {
      const userR = await pool.query<{ id: string }>(`select id::text as id from users where username = $1`, [
        username,
      ]);
      userId = userR.rows[0]?.id ?? null;
      if (!userId) {
        res.status(404).json({ ok: false, error: "Không tìm thấy người dùng với username này." });
        return;
      }
    }

    if (!userId) {
      res.status(400).json({ ok: false, error: "Body cần userId hoặc username." });
      return;
    }

    // Chỉ cho thêm user đã có quyền trong project (owner hoặc project_members)
    const allowed = await pool.query(
      `
      select 1
      from projects p
      where p.id = $1::uuid
        and (
          p.owner_user_id = $2::uuid
          or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $2::uuid)
        )
    `,
      [projectId, userId],
    );
    if ((allowed.rowCount ?? 0) === 0) {
      res.status(400).json({ ok: false, error: "Người dùng chưa là thành viên của dự án này." });
      return;
    }

    try {
      await pool.query(`insert into project_group_members(group_id, user_id) values ($1::uuid, $2::uuid)`, [
        groupId,
        userId,
      ]);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23505") {
        res.status(409).json({ ok: false, error: "Người này đã có trong nhóm." });
        return;
      }
      throw e;
    }
    res.status(201).json({ ok: true });
  },
);

projectsRouter.delete(
  "/:projectId/groups/:groupId/members/:memberUserId",
  requireProjectAccess,
  requireProjectManage,
  async (req, res) => {
    const pool = getPool();
    const { projectId, groupId = "" } = req.params as GroupParams;
    const memberUserId = String(req.params.memberUserId ?? "").trim();
    if (!groupId.trim()) {
      res.status(400).json({ ok: false, error: "Thiếu groupId" });
      return;
    }
    if (!memberUserId) {
      res.status(400).json({ ok: false, error: "Thiếu memberUserId" });
      return;
    }
    const ok = await assertGroupInProject(pool, projectId, groupId);
    if (!ok) {
      res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
      return;
    }
    const del = await pool.query(`delete from project_group_members where group_id=$1::uuid and user_id=$2::uuid`, [
      groupId,
      memberUserId,
    ]);
    if ((del.rowCount ?? 0) === 0) {
      res.status(404).json({ ok: false, error: "Không tìm thấy thành viên trong nhóm." });
      return;
    }
    res.json({ ok: true });
  },
);

projectsRouter.get("/:projectId/groups/:groupId/assignments", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  if (!(await assertGroupInProject(pool, projectId, groupId))) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  if (!(await assertGroupViewAllowed(pool, req.auth!, projectId, groupId))) {
    res.status(403).json({ ok: false, error: "Bạn không có quyền xem nhóm này." });
    return;
  }
  const canManage = await assertProjectManage(pool, req.auth!, projectId);
  const feats = await pool.query<{ id: string; name: string; key: string | null }>(
    `select id::text as id, name, key from features where project_id=$1::uuid order by name asc`,
    [projectId],
  );
  const tcs = await pool.query<{ id: string; name: string; featureId: string | null; featureName: string | null }>(
    `
    select tc.id::text as id, tc.name, tc.feature_id::text as "featureId", f.name as "featureName"
    from test_cases tc
    left join features f on f.id = tc.feature_id
    where f.project_id = $1::uuid
    order by f.name asc nulls last, tc.name asc
  `,
    [projectId],
  );
  const assignedFeat = await pool.query<{ id: string }>(
    `select feature_id::text as id from project_group_feature_assignments where group_id=$1::uuid`,
    [groupId],
  );
  const assignedTc = await pool.query<{ id: string }>(
    `select test_case_id::text as id from project_group_test_case_assignments where group_id=$1::uuid`,
    [groupId],
  );
  res.json({
    ok: true,
    canManage,
    features: feats.rows,
    testCases: tcs.rows,
    assignedFeatureIds: assignedFeat.rows.map((x) => x.id),
    assignedTestCaseIds: assignedTc.rows.map((x) => x.id),
  });
});

projectsRouter.put(
  "/:projectId/groups/:groupId/assignments",
  requireProjectAccess,
  requireProjectManage,
  async (req, res) => {
    const pool = getPool();
    const { projectId, groupId = "" } = req.params as GroupParams;
    if (!groupId.trim()) {
      res.status(400).json({ ok: false, error: "Thiếu groupId" });
      return;
    }
    const ok = await assertGroupInProject(pool, projectId, groupId);
    if (!ok) {
      res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
      return;
    }
    const body = req.body as { featureIds?: unknown; testCaseIds?: unknown };
    const featureIds = Array.isArray(body.featureIds) ? body.featureIds.filter((x) => typeof x === "string") : [];
    const testCaseIds = Array.isArray(body.testCaseIds) ? body.testCaseIds.filter((x) => typeof x === "string") : [];

    // validate belongs to project
    if (featureIds.length) {
      const chk = await pool.query<{ id: string }>(
        `select id::text as id from features where project_id=$1::uuid and id = any($2::uuid[])`,
        [projectId, featureIds],
      );
      if (chk.rows.length !== new Set(featureIds).size) {
        res.status(400).json({ ok: false, error: "featureIds có phần tử không thuộc dự án." });
        return;
      }
    }
    if (testCaseIds.length) {
      const chk = await pool.query<{ id: string }>(
        `
        select tc.id::text as id
        from test_cases tc
        join features f on f.id = tc.feature_id
        where f.project_id=$1::uuid and tc.id = any($2::text[])
      `,
        [projectId, testCaseIds],
      );
      if (chk.rows.length !== new Set(testCaseIds).size) {
        res.status(400).json({ ok: false, error: "testCaseIds có phần tử không thuộc dự án." });
        return;
      }
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from project_group_feature_assignments where group_id=$1::uuid`, [groupId]);
      await client.query(`delete from project_group_test_case_assignments where group_id=$1::uuid`, [groupId]);
      for (const fid of new Set(featureIds)) {
        await client.query(
          `insert into project_group_feature_assignments(group_id, feature_id) values ($1::uuid, $2::uuid)`,
          [groupId, fid],
        );
      }
      for (const tcid of new Set(testCaseIds)) {
        await client.query(
          `insert into project_group_test_case_assignments(group_id, test_case_id) values ($1::uuid, $2::text)`,
          [groupId, tcid],
        );
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  },
);

projectsRouter.get("/:projectId/groups/:groupId/stats", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  if (!(await assertGroupInProject(pool, projectId, groupId))) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  if (!(await assertGroupViewAllowed(pool, req.auth!, projectId, groupId))) {
    res.status(403).json({ ok: false, error: "Bạn không có quyền xem nhóm này." });
    return;
  }

  // Thống kê 7 ngày gần nhất cho các testcase "hiệu lực":
  // - gán trực tiếp vào nhóm
  // - hoặc thuộc feature được gán vào nhóm
  const stats = await pool.query<{
    effectiveTestCases: number;
    directTestCases: number;
    assignedFeatures: number;
    members: number;
    runs7d: number;
    passed7d: number;
    failed7d: number;
    passRate7d: number;
    lastRunAt: string | null;
    completedMarked: number;
  }>(
    `
    with
      feats as (
        select feature_id
        from project_group_feature_assignments
        where group_id = $1::uuid
      ),
      tcs_direct as (
        select test_case_id
        from project_group_test_case_assignments
        where group_id = $1::uuid
      ),
      tcs_from_feats as (
        select tc.id as test_case_id
        from test_cases tc
        join feats f on f.feature_id = tc.feature_id
      ),
      tcs_effective as (
        select test_case_id from tcs_direct
        union
        select test_case_id from tcs_from_feats
      ),
      runs7d as (
        select tr.overall_status, tr.finished_at
        from test_runs tr
        join tcs_effective t on t.test_case_id = tr.test_case_id
        where tr.finished_at >= now() - interval '7 days'
      )
    select
      (select count(*)::int from tcs_effective) as "effectiveTestCases",
      (select count(*)::int from tcs_direct) as "directTestCases",
      (select count(*)::int from feats) as "assignedFeatures",
      (select count(*)::int from project_group_members where group_id = $1::uuid) as "members",
      (select count(*)::int from runs7d) as "runs7d",
      (select count(*)::int from runs7d where overall_status = 'passed') as "passed7d",
      (select count(*)::int from runs7d where overall_status <> 'passed') as "failed7d",
      case
        when (select count(*) from runs7d) = 0 then 0
        else round(
          ((select count(*) from runs7d where overall_status = 'passed')::numeric
            / (select count(*) from runs7d)::numeric) * 100
        )::int
      end as "passRate7d",
      (select max(finished_at)::text from runs7d) as "lastRunAt",
      (
        select count(*)::int
        from project_group_tc_progress p
        join tcs_effective t on t.test_case_id = p.test_case_id
        where p.group_id = $1::uuid and p.completed = true
      ) as "completedMarked"
  `,
    [groupId],
  );
  res.json({ ok: true, stats: stats.rows[0] ?? null });
});

projectsRouter.get("/:projectId/groups/:groupId/detail", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  if (!(await assertGroupInProject(pool, projectId, groupId))) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  if (!(await assertGroupViewAllowed(pool, req.auth!, projectId, groupId))) {
    res.status(403).json({ ok: false, error: "Bạn không có quyền xem nhóm này." });
    return;
  }
  const canManage = await assertProjectManage(pool, req.auth!, projectId);

  const g = await pool.query<{
    id: string;
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
  }>(
    `select g.id::text as id, g.name, g.description, g.created_at::text as "createdAt", g.updated_at::text as "updatedAt"
     from project_groups g where g.id=$1::uuid and g.project_id=$2::uuid`,
    [groupId, projectId],
  );
  const groupRow = g.rows[0];
  if (!groupRow) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }

  const stats = await pool.query<{
    effectiveTestCases: number;
    directTestCases: number;
    assignedFeatures: number;
    members: number;
    runs7d: number;
    passed7d: number;
    failed7d: number;
    passRate7d: number;
    lastRunAt: string | null;
    completedMarked: number;
  }>(
    `
    with
      feats as (
        select feature_id
        from project_group_feature_assignments
        where group_id = $1::uuid
      ),
      tcs_direct as (
        select test_case_id
        from project_group_test_case_assignments
        where group_id = $1::uuid
      ),
      tcs_from_feats as (
        select tc.id as test_case_id
        from test_cases tc
        join feats f on f.feature_id = tc.feature_id
      ),
      tcs_effective as (
        select test_case_id from tcs_direct
        union
        select test_case_id from tcs_from_feats
      ),
      runs7d as (
        select tr.overall_status, tr.finished_at
        from test_runs tr
        join tcs_effective t on t.test_case_id = tr.test_case_id
        where tr.finished_at >= now() - interval '7 days'
      )
    select
      (select count(*)::int from tcs_effective) as "effectiveTestCases",
      (select count(*)::int from tcs_direct) as "directTestCases",
      (select count(*)::int from feats) as "assignedFeatures",
      (select count(*)::int from project_group_members where group_id = $1::uuid) as "members",
      (select count(*)::int from runs7d) as "runs7d",
      (select count(*)::int from runs7d where overall_status = 'passed') as "passed7d",
      (select count(*)::int from runs7d where overall_status <> 'passed') as "failed7d",
      case
        when (select count(*) from runs7d) = 0 then 0
        else round(
          ((select count(*) from runs7d where overall_status = 'passed')::numeric
            / (select count(*) from runs7d)::numeric) * 100
        )::int
      end as "passRate7d",
      (select max(finished_at)::text from runs7d) as "lastRunAt",
      (
        select count(*)::int
        from project_group_tc_progress p
        join tcs_effective t on t.test_case_id = p.test_case_id
        where p.group_id = $1::uuid and p.completed = true
      ) as "completedMarked"
  `,
    [groupId],
  );

  const tcRows = await pool.query<{
    id: string;
    name: string;
    featureId: string | null;
    featureName: string | null;
    completed: boolean;
    note: string;
    progressUpdatedAt: string | null;
    lastRunId: string | null;
    lastRunFinishedAt: string | null;
    lastRunOverallStatus: string | null;
  }>(
    `
    with
      feats as (
        select feature_id
        from project_group_feature_assignments
        where group_id = $1::uuid
      ),
      tcs_direct as (
        select test_case_id
        from project_group_test_case_assignments
        where group_id = $1::uuid
      ),
      tcs_from_feats as (
        select tc.id as test_case_id
        from test_cases tc
        join feats f on f.feature_id = tc.feature_id
      ),
      tcs_effective as (
        select test_case_id from tcs_direct
        union
        select test_case_id from tcs_from_feats
      )
    select
      tc.id::text as id,
      tc.name,
      tc.feature_id::text as "featureId",
      f.name as "featureName",
      coalesce(p.completed, false) as completed,
      coalesce(p.note, '') as note,
      p.updated_at::text as "progressUpdatedAt",
      lr.id::text as "lastRunId",
      lr.finished_at::text as "lastRunFinishedAt",
      lr.overall_status::text as "lastRunOverallStatus"
    from test_cases tc
    join features f on f.id = tc.feature_id
    join tcs_effective e on e.test_case_id = tc.id
    left join project_group_tc_progress p on p.group_id = $1::uuid and p.test_case_id = tc.id
    left join lateral (
      select tr.id, tr.finished_at, tr.overall_status
      from test_runs tr
      where tr.test_case_id = tc.id
      order by tr.finished_at desc nulls last
      limit 1
    ) lr on true
    where f.project_id = $2::uuid
    order by f.name asc nulls last, tc.name asc
  `,
    [groupId, projectId],
  );

  const testCases = tcRows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    featureId: row.featureId,
    featureName: row.featureName,
    completed: row.completed,
    note: row.note,
    progressUpdatedAt: row.progressUpdatedAt,
    lastRun:
      row.lastRunId != null
        ? {
            id: row.lastRunId,
            finishedAt: row.lastRunFinishedAt,
            overallStatus: row.lastRunOverallStatus,
          }
        : null,
  }));

  res.json({
    ok: true,
    group: groupRow,
    overview: stats.rows[0] ?? null,
    testCases,
    canManage,
  });
});

projectsRouter.get("/:projectId/groups/:groupId/runs", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  if (!(await assertGroupInProject(pool, projectId, groupId))) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  if (!(await assertGroupViewAllowed(pool, req.auth!, projectId, groupId))) {
    res.status(403).json({ ok: false, error: "Bạn không có quyền xem nhóm này." });
    return;
  }

  const limitRaw = (req.query.limit as string | undefined) ?? "40";
  const offsetRaw = (req.query.offset as string | undefined) ?? "0";
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  const lim = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 40;
  const off = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

  const runsQ = await pool.query<{
    id: string;
    testCaseId: string;
    testCaseName: string;
    featureName: string | null;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    overallStatus: string;
    triggeredByUsername: string | null;
  }>(
    `
    with
      feats as (
        select feature_id
        from project_group_feature_assignments
        where group_id = $1::uuid
      ),
      tcs_direct as (
        select test_case_id
        from project_group_test_case_assignments
        where group_id = $1::uuid
      ),
      tcs_from_feats as (
        select tc.id as test_case_id
        from test_cases tc
        join feats f on f.feature_id = tc.feature_id
      ),
      tcs_effective as (
        select test_case_id from tcs_direct
        union
        select test_case_id from tcs_from_feats
      )
    select
      tr.id::text as id,
      tr.test_case_id as "testCaseId",
      tc.name as "testCaseName",
      f.name as "featureName",
      tr.started_at::text as "startedAt",
      tr.finished_at::text as "finishedAt",
      tr.duration_ms as "durationMs",
      tr.overall_status::text as "overallStatus",
      u.username as "triggeredByUsername"
    from test_runs tr
    join tcs_effective te on te.test_case_id = tr.test_case_id
    join test_cases tc on tc.id = tr.test_case_id
    join features f on f.id = tc.feature_id
    left join users u on u.id = tr.triggered_by_user_id
    where f.project_id = $2::uuid
    order by tr.finished_at desc nulls last
    limit $3 offset $4
  `,
    [groupId, projectId, lim, off],
  );

  res.json({ ok: true, runs: runsQ.rows, limit: lim, offset: off });
});

projectsRouter.patch("/:projectId/groups/:groupId/progress", requireProjectAccess, async (req, res) => {
  const pool = getPool();
  const { projectId, groupId = "" } = req.params as GroupParams;
  if (!groupId.trim()) {
    res.status(400).json({ ok: false, error: "Thiếu groupId" });
    return;
  }
  if (!(await assertGroupInProject(pool, projectId, groupId))) {
    res.status(404).json({ ok: false, error: "Không tìm thấy nhóm" });
    return;
  }
  if (!(await assertGroupViewAllowed(pool, req.auth!, projectId, groupId))) {
    res.status(403).json({ ok: false, error: "Bạn không có quyền cập nhật tiến độ nhóm này." });
    return;
  }

  const body = req.body as { testCaseId?: unknown; completed?: unknown; note?: unknown };
  const testCaseId = typeof body.testCaseId === "string" ? body.testCaseId.trim() : "";
  if (!testCaseId) {
    res.status(400).json({ ok: false, error: "Thiếu testCaseId" });
    return;
  }

  const inSetQ = await pool.query<{ ok: boolean }>(
    `
    with
      feats as (
        select feature_id
        from project_group_feature_assignments
        where group_id = $1::uuid
      ),
      tcs_direct as (
        select test_case_id
        from project_group_test_case_assignments
        where group_id = $1::uuid
      ),
      tcs_from_feats as (
        select tc.id as test_case_id
        from test_cases tc
        join feats f on f.feature_id = tc.feature_id
      ),
      tcs_effective as (
        select test_case_id from tcs_direct
        union
        select test_case_id from tcs_from_feats
      )
    select exists(
      select 1
      from tcs_effective e
      join test_cases tc on tc.id = e.test_case_id
      join features fe on fe.id = tc.feature_id
      where fe.project_id = $3::uuid and e.test_case_id = $2
    ) as ok
  `,
    [groupId, testCaseId, projectId],
  );
  if (!inSetQ.rows[0]?.ok) {
    res.status(400).json({ ok: false, error: "Test case không nằm trong phạm vi giao cho nhóm." });
    return;
  }

  const prev = await pool.query<{ completed: boolean; note: string }>(
    `select completed, note from project_group_tc_progress where group_id=$1::uuid and test_case_id=$2`,
    [groupId, testCaseId],
  );
  const prevC = prev.rows[0]?.completed ?? false;
  const prevN = prev.rows[0]?.note ?? "";

  const completed = body.completed !== undefined ? Boolean(body.completed) : prevC;
  const note = body.note !== undefined ? String(body.note) : prevN;

  const up = await pool.query<{
    completed: boolean;
    note: string;
    updated_at: string;
  }>(
    `
    insert into project_group_tc_progress (group_id, test_case_id, completed, note, updated_at)
    values ($1::uuid, $2, $3, $4, now())
    on conflict (group_id, test_case_id) do update set
      completed = excluded.completed,
      note = excluded.note,
      updated_at = now()
    returning completed, note, updated_at::text
  `,
    [groupId, testCaseId, completed, note],
  );

  const row = up.rows[0];
  res.json({
    ok: true,
    progress: {
      testCaseId,
      completed: row?.completed ?? completed,
      note: row?.note ?? note,
      updatedAt: row?.updated_at ?? null,
    },
  });
});

/** Các gói thao tác trong dự án (testcase đã đóng gói). */
projectsRouter.get("/:projectId/operation-packages", requireProjectAccess, async (req, res) => {
  const projectId = String(req.params.projectId ?? "");
  const pool = getPool();
  const q = await pool.query(
    `
    select tc.id,
           tc.feature_id::text as "featureId",
           tc.key,
           tc.name,
           tc.description,
           tc.status,
           tc.priority,
           tc.created_at,
           tc.updated_at,
           tc.is_operation_package as "isOperationPackage",
           tc.packed_at as "packedAt",
           tc.packed_from_test_case_id as "packedFromTestCaseId",
           u.username as "packedByUsername"
    from test_cases tc
    inner join features f on f.id = tc.feature_id
    left join users u on u.id = tc.packed_by_user_id
    where f.project_id = $1::uuid and tc.is_operation_package = true
    order by tc.updated_at desc
  `,
    [projectId],
  );
  res.json({ ok: true, packages: q.rows });
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
