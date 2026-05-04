import { Router } from "express";
import { getPool } from "../db";
import { requireAuth, requireProjectAccess } from "../auth/middleware";

export const featuresRouter = Router({ mergeParams: true });

type FeatureParams = { projectId: string; featureId?: string };

featuresRouter.use(requireAuth, requireProjectAccess);

featuresRouter.get("/", async (req, res) => {
  const pool = getPool();
  const r = await pool.query(
    `select id::text as id, project_id::text as projectId, key, name, description, created_at, updated_at
     from features
     where project_id=$1
     order by updated_at desc`,
    [(req.params as FeatureParams).projectId],
  );
  res.json({ ok: true, features: r.rows });
});

featuresRouter.post("/", async (req, res) => {
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
    `insert into features(project_id, key, name, description)
     values ($1, $2, $3, $4)
     returning id::text as id, project_id::text as projectId, key, name, description, created_at, updated_at`,
    [(req.params as FeatureParams).projectId, key, name, description],
  );
  res.status(201).json({ ok: true, feature: r.rows[0] });
});

featuresRouter.put("/:featureId", async (req, res) => {
  const body = req.body as Partial<{ key: string; name: string; description: string }>;
  const key = body.key !== undefined ? String(body.key).trim() : undefined;
  const name = body.name !== undefined ? String(body.name).trim() : undefined;
  const description =
    body.description !== undefined ? String(body.description).trim() : undefined;

  const pool = getPool();
  const r = await pool.query(
    `update features
     set key = coalesce($3, key),
         name = coalesce($4, name),
         description = coalesce($5, description),
         updated_at = now()
     where project_id=$1 and id=$2
     returning id::text as id, project_id::text as projectId, key, name, description, created_at, updated_at`,
    [
      (req.params as FeatureParams).projectId,
      (req.params as FeatureParams).featureId,
      key ?? null,
      name ?? null,
      description ?? null,
    ],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy feature" });
    return;
  }
  res.json({ ok: true, feature: r.rows[0] });
});

featuresRouter.delete("/:featureId", async (req, res) => {
  const pool = getPool();
  const r = await pool.query(`delete from features where project_id=$1 and id=$2`, [
    (req.params as FeatureParams).projectId,
    (req.params as FeatureParams).featureId,
  ]);
  if ((r.rowCount ?? 0) === 0) {
    res.status(404).json({ ok: false, error: "Không tìm thấy feature" });
    return;
  }
  res.json({ ok: true });
});

