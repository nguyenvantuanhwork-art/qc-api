import { getPool } from "../db";
import { notifyTestRunFinished } from "../notifications/store";
import type { ActiveRunPublicSnapshot } from "../testCaseActions/activeRunRegistry";
import type { GlobalTestRunListRow, TestRunDetail, TestRunRow } from "./types";

type RunResultShape = {
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  overallStatus?: "passed" | "failed";
};

function asIsoString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // keep it permissive; UI expects ISO, but DB can store any timestamptz-compatible string
  return v.trim() || null;
}

function normalizeRunResult(result: unknown): Required<RunResultShape> {
  const r = (result ?? {}) as RunResultShape;
  const startedAt = asIsoString(r.startedAt) ?? new Date().toISOString();
  const finishedAt = asIsoString(r.finishedAt) ?? new Date().toISOString();
  const durationMs =
    typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? Math.max(0, Math.floor(r.durationMs)) : 0;
  const overallStatus = r.overallStatus === "passed" ? "passed" : "failed";
  return { startedAt, finishedAt, durationMs, overallStatus };
}

export async function insertTestRun(
  testCaseId: string,
  result: unknown,
  triggeredByUserId?: string | null,
): Promise<TestRunRow> {
  const pool = getPool();
  const norm = normalizeRunResult(result);

  const q = await pool.query<{
    id: string;
    test_case_id: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    overall_status: "passed" | "failed";
  }>(
    `
    insert into test_runs(test_case_id, started_at, finished_at, duration_ms, overall_status, result, triggered_by_user_id)
    values ($1, $2, $3, $4, $5, $6::jsonb, $7)
    returning id, test_case_id, started_at, finished_at, duration_ms, overall_status
  `,
    [
      testCaseId,
      norm.startedAt,
      norm.finishedAt,
      norm.durationMs,
      norm.overallStatus,
      JSON.stringify(result ?? {}),
      triggeredByUserId ?? null,
    ],
  );

  const row = q.rows[0]!;
  const mapped = {
    id: row.id,
    testCaseId: row.test_case_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    overallStatus: row.overall_status,
  };
  if (triggeredByUserId) {
    void notifyTestRunFinished({
      userId: triggeredByUserId,
      testCaseId,
      runId: mapped.id,
      overallStatus: mapped.overallStatus,
      durationMs: mapped.durationMs,
    });
  }
  return mapped;
}

export async function updateTestRunResult(runId: string, result: unknown): Promise<void> {
  const pool = getPool();
  await pool.query(`update test_runs set result = $1::jsonb where id = $2::uuid`, [
    JSON.stringify(result ?? {}),
    runId,
  ]);
}

export async function listTestRuns(testCaseId: string, limit = 30): Promise<TestRunRow[]> {
  const pool = getPool();
  const n = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 30;
  const q = await pool.query<{
    id: string;
    test_case_id: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    overall_status: "passed" | "failed";
    triggered_by_username: string | null;
  }>(
    `
    select tr.id, tr.test_case_id, tr.started_at, tr.finished_at, tr.duration_ms, tr.overall_status,
           u.username as triggered_by_username
    from test_runs tr
    left join users u on u.id = tr.triggered_by_user_id
    where tr.test_case_id = $1
    order by tr.finished_at desc
    limit $2
  `,
    [testCaseId, n],
  );
  return q.rows.map((r) => ({
    id: r.id,
    testCaseId: r.test_case_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    overallStatus: r.overall_status,
    triggeredByUsername: r.triggered_by_username,
  }));
}

export async function listGlobalTestRuns(
  isAdmin: boolean,
  userId: string,
  limit = 50,
  offset = 0,
): Promise<GlobalTestRunListRow[]> {
  const pool = getPool();
  const lim = Math.min(100, Math.max(1, Math.floor(limit)));
  const off = Math.max(0, Math.floor(offset));

  const q = await pool.query<{
    id: string;
    testCaseId: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    overallStatus: "passed" | "failed";
    testCaseName: string | null;
    testCaseKey: string | null;
    featureId: string | null;
    featureName: string | null;
    featureKey: string | null;
    projectId: string | null;
    projectName: string | null;
    projectKey: string | null;
    triggeredByUsername: string | null;
    hasScreenshots: boolean;
  }>(
    `
    select
      tr.id::text as "id",
      tr.test_case_id as "testCaseId",
      tr.started_at as "startedAt",
      tr.finished_at as "finishedAt",
      tr.duration_ms as "durationMs",
      tr.overall_status::text as "overallStatus",
      tc.name as "testCaseName",
      tc.key as "testCaseKey",
      f.id::text as "featureId",
      f.name as "featureName",
      f.key as "featureKey",
      p.id::text as "projectId",
      p.name as "projectName",
      p.key as "projectKey",
      u.username as "triggeredByUsername",
      exists (
        select 1
        from jsonb_array_elements(coalesce(tr.result->'steps', '[]'::jsonb)) as step
        where (
          (step->>'screenshotObjectKey') is not null
          and length(trim(step->>'screenshotObjectKey')) > 0
        ) or (
          (step->>'screenshotBase64') is not null
          and length(step->>'screenshotBase64') > 0
        )
      ) as "hasScreenshots"
    from test_runs tr
    inner join test_cases tc on tc.id = tr.test_case_id
    left join features f on f.id = tc.feature_id
    left join projects p on p.id = f.project_id
    left join users u on u.id = tr.triggered_by_user_id
    where (
      $1::boolean
      or (
        p.id is not null
        and (
          p.owner_user_id = $2::uuid
          or exists (
            select 1 from project_members pm
            where pm.project_id = p.id and pm.user_id = $2::uuid
          )
        )
      )
    )
    order by tr.finished_at desc
    limit $3 offset $4
  `,
    [isAdmin, userId, lim, off],
  );

  return q.rows.map((r) => ({
    id: r.id,
    testCaseId: r.testCaseId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    overallStatus: r.overallStatus === "passed" ? "passed" : "failed",
    triggeredByUsername: r.triggeredByUsername,
    testCaseName: r.testCaseName,
    testCaseKey: r.testCaseKey,
    featureId: r.featureId,
    featureName: r.featureName,
    featureKey: r.featureKey,
    projectId: r.projectId,
    projectName: r.projectName,
    projectKey: r.projectKey,
    hasScreenshots: Boolean(r.hasScreenshots),
  }));
}

export async function getTestRun(runId: string): Promise<TestRunDetail | null> {
  const pool = getPool();
  const q = await pool.query<{
    id: string;
    test_case_id: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    overall_status: "passed" | "failed";
    result: unknown;
    triggered_by_username: string | null;
  }>(
    `
    select tr.id, tr.test_case_id, tr.started_at, tr.finished_at, tr.duration_ms, tr.overall_status, tr.result,
           u.username as triggered_by_username
    from test_runs tr
    left join users u on u.id = tr.triggered_by_user_id
    where tr.id = $1
    limit 1
  `,
    [runId],
  );
  const r = q.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    testCaseId: r.test_case_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    overallStatus: r.overall_status,
    triggeredByUsername: r.triggered_by_username,
    result: r.result,
  };
}

export type EnrichedActiveRunRow = ActiveRunPublicSnapshot & {
  testCaseName: string | null;
  testCaseKey: string | null;
  featureId: string | null;
  featureName: string | null;
  projectId: string | null;
  projectName: string | null;
};

export async function enrichActiveRunSnapshots(rows: ActiveRunPublicSnapshot[]): Promise<EnrichedActiveRunRow[]> {
  if (rows.length === 0) return [];
  const pool = getPool();
  const ids = rows.map((r) => r.testCaseId);
  const q = await pool.query<{
    test_case_id: string;
    test_case_name: string | null;
    test_case_key: string | null;
    feature_id: string | null;
    feature_name: string | null;
    project_id: string | null;
    project_name: string | null;
  }>(
    `
    select tc.id::text as test_case_id, tc.name as test_case_name, tc.key as test_case_key,
           f.id::text as feature_id, f.name as feature_name,
           p.id::text as project_id, p.name as project_name
    from test_cases tc
    left join features f on f.id = tc.feature_id
    left join projects p on p.id = f.project_id
    where tc.id = any($1::text[])
  `,
    [ids],
  );
  const meta = new Map(q.rows.map((r) => [r.test_case_id, r]));
  return rows.map((s) => {
    const m = meta.get(s.testCaseId);
    return {
      ...s,
      testCaseName: m?.test_case_name ?? null,
      testCaseKey: m?.test_case_key ?? null,
      featureId: m?.feature_id ?? null,
      featureName: m?.feature_name ?? null,
      projectId: m?.project_id ?? null,
      projectName: m?.project_name ?? null,
    };
  });
}

