import { getPool } from "../db";
import type { AuthPayload } from "../auth/types";
import { assertProjectAccess } from "../auth/access";
import type { ReportDayBucket, ReportErrorTrend, ReportSummary, ReportTopFailingTestCase } from "./types";

const MAX_REPORT_DAYS = 90;
const MIN_REPORT_DAYS = 1;

function clampDays(n: number): number {
  if (!Number.isFinite(n)) return 14;
  return Math.min(MAX_REPORT_DAYS, Math.max(MIN_REPORT_DAYS, Math.floor(n)));
}

/** CTE: các lần chạy user được xem (cùng logic listGlobalTestRuns) + lọc project. */
function visibleRunsSql(): string {
  return `
    visible_runs AS (
      SELECT
        tr.id,
        tr.test_case_id,
        tr.finished_at,
        tr.duration_ms,
        tr.overall_status,
        tr.result,
        tc.name AS tc_name,
        p.name AS project_name
      FROM test_runs tr
      INNER JOIN test_cases tc ON tc.id = tr.test_case_id
      LEFT JOIN features f ON f.id = tc.feature_id
      LEFT JOIN projects p ON p.id = f.project_id
      WHERE tr.finished_at >= NOW() - ($3::int * INTERVAL '1 day')
        AND ($4::uuid IS NULL OR p.id = $4::uuid)
        AND (
          $1::boolean
          OR (
            p.id IS NOT NULL
            AND (
              p.owner_user_id = $2::uuid
              OR EXISTS (
                SELECT 1 FROM project_members pm
                WHERE pm.project_id = p.id AND pm.user_id = $2::uuid
              )
            )
          )
        )
    )`;
}

export async function getReportSummary(
  auth: AuthPayload,
  opts: { days: number; projectId: string | null },
): Promise<{ ok: true; summary: ReportSummary } | { ok: false; error: string }> {
  const pool = getPool();
  const days = clampDays(opts.days);
  const projectId = opts.projectId?.trim() || null;

  if (projectId) {
    const ok = await assertProjectAccess(pool, auth, projectId);
    if (!ok) return { ok: false, error: "Không có quyền xem dự án này." };
  }

  const isAdmin = auth.role === "admin";
  const params = [isAdmin, auth.userId, days, projectId];

  const cte = visibleRunsSql();

  const seriesQ = await pool.query<{
    day: string;
    total_runs: string;
    passed: string;
    failed: string;
    avg_duration_ms: string;
  }>(
    `
    WITH ${cte}
    SELECT
      (vr.finished_at AT TIME ZONE 'UTC')::date::text AS day,
      COUNT(*)::text AS total_runs,
      SUM(CASE WHEN vr.overall_status = 'passed' THEN 1 ELSE 0 END)::text AS passed,
      SUM(CASE WHEN vr.overall_status = 'failed' THEN 1 ELSE 0 END)::text AS failed,
      COALESCE(AVG(vr.duration_ms)::bigint, 0)::text AS avg_duration_ms
    FROM visible_runs vr
    GROUP BY (vr.finished_at AT TIME ZONE 'UTC')::date
    ORDER BY day ASC
    `,
    params,
  );

  const topQ = await pool.query<{
    test_case_id: string;
    test_case_name: string | null;
    project_name: string | null;
    total_runs: string;
    failed_runs: string;
  }>(
    `
    WITH ${cte}
    SELECT
      vr.test_case_id::text,
      MAX(vr.tc_name) AS test_case_name,
      MAX(vr.project_name) AS project_name,
      COUNT(*)::text AS total_runs,
      SUM(CASE WHEN vr.overall_status = 'failed' THEN 1 ELSE 0 END)::text AS failed_runs
    FROM visible_runs vr
    GROUP BY vr.test_case_id
    HAVING SUM(CASE WHEN vr.overall_status = 'failed' THEN 1 ELSE 0 END) > 0
    ORDER BY SUM(CASE WHEN vr.overall_status = 'failed' THEN 1 ELSE 0 END) DESC,
             COUNT(*) DESC
    LIMIT 15
    `,
    params,
  );

  const errQ = await pool.query<{
    error_key: string;
    cnt: string;
    last_seen: string;
  }>(
    `
    WITH ${cte},
    keys AS (
      SELECT
        LEFT(
          COALESCE(
            NULLIF(TRIM(vr.result->>'error'), ''),
            (
              SELECT step->>'message'
              FROM jsonb_array_elements(COALESCE(vr.result->'steps', '[]'::jsonb)) AS step
              WHERE step->>'status' = 'failed'
              LIMIT 1
            ),
            'Không có thông điệp lỗi'
          ),
          320
        ) AS error_key,
        vr.finished_at
      FROM visible_runs vr
      WHERE vr.overall_status = 'failed'
    )
    SELECT
      error_key,
      COUNT(*)::text AS cnt,
      MAX(finished_at)::text AS last_seen
    FROM keys
    WHERE error_key IS NOT NULL AND LENGTH(TRIM(error_key)) > 0
    GROUP BY error_key
    ORDER BY COUNT(*) DESC, MAX(finished_at) DESC
    LIMIT 25
    `,
    params,
  );

  const series: ReportDayBucket[] = seriesQ.rows.map((r) => ({
    day: r.day,
    totalRuns: Number(r.total_runs) || 0,
    passed: Number(r.passed) || 0,
    failed: Number(r.failed) || 0,
    avgDurationMs: Number(r.avg_duration_ms) || 0,
  }));

  const topFailingTestCases: ReportTopFailingTestCase[] = topQ.rows.map((r) => ({
    testCaseId: r.test_case_id,
    testCaseName: r.test_case_name,
    projectName: r.project_name,
    totalRuns: Number(r.total_runs) || 0,
    failedRuns: Number(r.failed_runs) || 0,
  }));

  const errorTrends: ReportErrorTrend[] = errQ.rows.map((r) => ({
    errorKey: r.error_key,
    count: Number(r.cnt) || 0,
    lastSeenAt: r.last_seen,
  }));

  let totalRuns = 0;
  let passed = 0;
  let failed = 0;
  for (const b of series) {
    totalRuns += b.totalRuns;
    passed += b.passed;
    failed += b.failed;
  }
  const passRate = totalRuns > 0 ? Math.round((passed / totalRuns) * 1000) / 10 : 0;

  return {
    ok: true,
    summary: {
      days,
      projectId,
      totals: { totalRuns, passed, failed, passRate },
      series,
      topFailingTestCases,
      errorTrends,
    },
  };
}
