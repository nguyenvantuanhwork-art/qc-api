import { randomBytes } from "node:crypto";
import { Router } from "express";
import { getPool } from "../db";
import { requireAuth, requireProjectAccess, requireFeatureInProject } from "../auth/middleware";
import { assertFeatureInProject } from "../auth/access";
import {
  listDirectPrerequisitesDetail,
  replacePrerequisites,
  validatePrerequisiteChange,
} from "../testCasePrerequisites/store";
import { listActions, createAction } from "../testCaseActions/store";

export const testCasesRouter = Router({ mergeParams: true });

type TestCaseParams = { projectId: string; featureId: string; testCaseId?: string };

/** ID testcase text duy nhất cho gói thao tác — không bắt người dùng nhập. */
async function allocateUniqueOperationPackageId(pool: ReturnType<typeof getPool>): Promise<string | null> {
  for (let i = 0; i < 12; i++) {
    const id = `goi-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
    const chk = await pool.query(`select 1 from test_cases where id = $1`, [id]);
    if ((chk.rowCount ?? 0) === 0) return id;
  }
  return null;
}

testCasesRouter.use(requireAuth, requireProjectAccess, requireFeatureInProject);

testCasesRouter.get("/", async (req, res) => {
  const pool = getPool();
  const r = await pool.query(
    `select tc.id,
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
            u.username as "packedByUsername"
     from test_cases tc
     left join users u on u.id = tc.packed_by_user_id
     where tc.feature_id=$1
       and coalesce(tc.is_operation_package, false) = false
     order by tc.updated_at desc`,
    [(req.params as TestCaseParams).featureId],
  );
  res.json({ ok: true, testCases: r.rows });
});

testCasesRouter.post("/", async (req, res) => {
  const body = req.body as Partial<{
    id: string;
    key: string;
    name: string;
    description: string;
    status: string;
    priority: string;
  }>;
  const id = body.id ? String(body.id).trim() : null;
  const key = body.key ? String(body.key).trim() : null;
  const name = body.name ? String(body.name).trim() : "";
  const description = body.description ? String(body.description).trim() : "";
  const status = body.status ? String(body.status).trim() : "active";
  const priority = body.priority ? String(body.priority).trim() : "medium";

  if (!id) {
    res.status(400).json({ ok: false, error: "Thiếu id (ví dụ: tc-001)" });
    return;
  }
  if (!name) {
    res.status(400).json({ ok: false, error: "Thiếu name" });
    return;
  }

  const pool = getPool();
  const r = await pool.query(
    `insert into test_cases(id, feature_id, key, name, description, status, priority)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, feature_id::text as featureId, key, name, description, status, priority, created_at, updated_at`,
    [id, (req.params as TestCaseParams).featureId, key, name, description, status, priority],
  );
  res.status(201).json({ ok: true, testCase: r.rows[0] });
});

testCasesRouter.get("/:testCaseId", async (req, res) => {
  const { featureId, projectId } = req.params as TestCaseParams;
  const testCaseId = String(req.params.testCaseId ?? "").trim();
  const pool = getPool();
  const r = await pool.query(
    `select tc.id,
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
            tc.packed_by_user_id::text as "packedByUserId",
            u.username as "packedByUsername"
     from test_cases tc
     left join users u on u.id = tc.packed_by_user_id
     where tc.id = $1 and tc.feature_id = $2::uuid`,
    [testCaseId, featureId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy test case" });
    return;
  }
  const prerequisites = await listDirectPrerequisitesDetail(testCaseId);
  res.json({ ok: true, testCase: r.rows[0], prerequisites });
});

testCasesRouter.put("/:testCaseId/prerequisites", async (req, res) => {
  const { featureId, projectId } = req.params as TestCaseParams;
  const testCaseId = String(req.params.testCaseId ?? "").trim();
  const raw = req.body as { prerequisiteTestCaseIds?: unknown };
  if (!Array.isArray(raw.prerequisiteTestCaseIds)) {
    res.status(400).json({ ok: false, error: "Cần prerequisiteTestCaseIds (mảng id testcase)." });
    return;
  }
  const ids = raw.prerequisiteTestCaseIds.map((x) => String(x ?? "").trim()).filter(Boolean);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }

  const pool = getPool();
  const hostOk = await pool.query(`select 1 from test_cases where id = $1 and feature_id = $2::uuid`, [
    testCaseId,
    featureId,
  ]);
  if ((hostOk.rowCount ?? 0) === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy test case" });
    return;
  }

  const cycleErr = await validatePrerequisiteChange(pool, projectId, testCaseId, deduped);
  if (cycleErr) {
    res.status(400).json({ ok: false, error: cycleErr });
    return;
  }

  try {
    await replacePrerequisites(testCaseId, deduped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg });
    return;
  }

  const prerequisites = await listDirectPrerequisitesDetail(testCaseId);
  res.json({ ok: true, prerequisites });
});

testCasesRouter.post("/:testCaseId/operation-package", async (req, res) => {
  const { featureId, projectId } = req.params as TestCaseParams;
  const sourceTestCaseId = String(req.params.testCaseId ?? "").trim();
  const auth = req.auth!;

  const body = req.body as Partial<{
    name: string;
    description: string;
    targetFeatureId: string;
  }>;

  const name = body.name ? String(body.name).trim() : "";
  const description = body.description ? String(body.description).trim() : "";
  const targetFeatureId = body.targetFeatureId ? String(body.targetFeatureId).trim() : featureId;

  if (!name) {
    res.status(400).json({ ok: false, error: "Thiếu name." });
    return;
  }

  const pool = getPool();

  const src = await pool.query(`select id from test_cases where id = $1 and feature_id = $2::uuid`, [
    sourceTestCaseId,
    featureId,
  ]);
  if ((src.rowCount ?? 0) === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy test case nguồn" });
    return;
  }

  const featOk = await assertFeatureInProject(pool, projectId, targetFeatureId);
  if (!featOk) {
    res.status(400).json({ ok: false, error: "Feature đích không thuộc dự án." });
    return;
  }

  const newId = await allocateUniqueOperationPackageId(pool);
  if (!newId) {
    res.status(500).json({ ok: false, error: "Không tạo được id testcase duy nhất." });
    return;
  }

  const key = null;

  const ins = await pool.query(
    `insert into test_cases(
       id, feature_id, key, name, description, status, priority,
       is_operation_package, packed_by_user_id, packed_at, packed_from_test_case_id
     )
     values ($1, $2::uuid, $3, $4, $5, 'active', 'medium', true, $6::uuid, now(), $7)
     returning id, feature_id::text as "featureId", key, name, description, status, priority,
               created_at, updated_at,
               is_operation_package as "isOperationPackage",
               packed_at as "packedAt",
               packed_from_test_case_id as "packedFromTestCaseId",
               packed_by_user_id::text as "packedByUserId"`,
    [newId, targetFeatureId, key, name, description, auth.userId, sourceTestCaseId],
  );

  const actions = await listActions(sourceTestCaseId);
  for (const a of actions) {
    const { error } = await createAction(newId, {
      name: a.name,
      kind: a.kind,
      config: a.config,
      expectation: a.expectation,
      enabled: a.enabled,
    });
    if (error) {
      await pool.query(`delete from test_cases where id = $1`, [newId]);
      res.status(400).json({ ok: false, error: error ?? "Sao chép bước thất bại" });
      return;
    }
  }

  const uRow = await pool.query<{ username: string }>(`select username from users where id = $1::uuid`, [
    auth.userId,
  ]);

  const row = ins.rows[0];
  res.status(201).json({
    ok: true,
    testCase: { ...row, packedByUsername: uRow.rows[0]?.username ?? null },
    actionsCopied: actions.length,
  });
});

testCasesRouter.put("/:testCaseId", async (req, res) => {
  const body = req.body as Partial<{
    key: string;
    name: string;
    description: string;
    status: string;
    priority: string;
  }>;

  const pool = getPool();
  const r = await pool.query(
    `update test_cases
     set key=coalesce($3, key),
         name=coalesce($4, name),
         description=coalesce($5, description),
         status=coalesce($6, status),
         priority=coalesce($7, priority),
         updated_at=now()
     where feature_id=$1 and id=$2
     returning id, feature_id::text as featureId, key, name, description, status, priority, created_at, updated_at`,
    [
      (req.params as TestCaseParams).featureId,
      (req.params as TestCaseParams).testCaseId,
      body.key !== undefined ? String(body.key).trim() : null,
      body.name !== undefined ? String(body.name).trim() : null,
      body.description !== undefined ? String(body.description).trim() : null,
      body.status !== undefined ? String(body.status).trim() : null,
      body.priority !== undefined ? String(body.priority).trim() : null,
    ],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy test case" });
    return;
  }
  res.json({ ok: true, testCase: r.rows[0] });
});

testCasesRouter.delete("/:testCaseId", async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`delete from test_cases where feature_id=$1 and id=$2`, [
    (req.params as TestCaseParams).featureId,
    (req.params as TestCaseParams).testCaseId,
  ]);
  if ((r.rowCount ?? 0) === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy test case" });
    return;
  }
  res.json({ ok: true });
});

