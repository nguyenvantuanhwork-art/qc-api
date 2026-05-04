import { getPool } from "../db";

/** project_id của testcase (qua feature). */
export async function getProjectIdForTestCase(testCaseId: string): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query<{ project_id: string }>(
    `select f.project_id::text as project_id
     from test_cases tc
     join features f on f.id = tc.feature_id
     where tc.id = $1`,
    [testCaseId],
  );
  return r.rows[0]?.project_id ?? null;
}
