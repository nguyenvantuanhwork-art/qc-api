import { Router } from "express";
import { getPool } from "../db";
import { requireAuth, requireProjectAccess, requireFeatureInProject } from "../auth/middleware";

export const testCasesRouter = Router({ mergeParams: true });

type TestCaseParams = { featureId: string; testCaseId?: string };

testCasesRouter.use(requireAuth, requireProjectAccess, requireFeatureInProject);

testCasesRouter.get("/", async (req, res) => {
  const pool = getPool();
  const r = await pool.query(
    `select id, feature_id::text as featureId, key, name, description, status, priority, created_at, updated_at
     from test_cases
     where feature_id=$1
     order by updated_at desc`,
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

