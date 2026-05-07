import type { Pool } from "pg";
import { getPool } from "../db";

export type PrerequisiteListItem = {
  testCaseId: string;
  order: number;
  name: string;
  key: string | null;
  featureId: string | null;
  featureName: string | null;
};

export async function listDirectPrerequisiteIds(hostTestCaseId: string): Promise<string[]> {
  const pool = getPool();
  const r = await pool.query<{ prerequisite_test_case_id: string }>(
    `select prerequisite_test_case_id
     from test_case_prerequisites
     where host_test_case_id = $1
     order by order_index asc`,
    [hostTestCaseId],
  );
  return r.rows.map((x) => x.prerequisite_test_case_id);
}

export async function listDirectPrerequisitesDetail(hostTestCaseId: string): Promise<PrerequisiteListItem[]> {
  const pool = getPool();
  const r = await pool.query<{
    test_case_id: string;
    order_index: number;
    name: string;
    key: string | null;
    feature_id: string | null;
    feature_name: string | null;
  }>(
    `select p.prerequisite_test_case_id as test_case_id,
            p.order_index,
            tc.name,
            tc.key,
            tc.feature_id::text as feature_id,
            f.name as feature_name
     from test_case_prerequisites p
     join test_cases tc on tc.id = p.prerequisite_test_case_id
     left join features f on f.id = tc.feature_id
     where p.host_test_case_id = $1
     order by p.order_index asc`,
    [hostTestCaseId],
  );
  return r.rows.map((row) => ({
    testCaseId: String(row.test_case_id).trim(),
    order: row.order_index,
    name: row.name,
    key: row.key,
    featureId: row.feature_id ? String(row.feature_id).trim() : null,
    featureName: row.feature_name,
  }));
}

/** Cạnh prereq → host (prereq chạy trước host). */
async function loadPrerequisiteEdgesInProject(pool: Pool, projectId: string): Promise<Map<string, string[]>> {
  const r = await pool.query<{ host: string; prereq: string }>(
    `select p.host_test_case_id as host, p.prerequisite_test_case_id as prereq
     from test_case_prerequisites p
     inner join test_cases tc on tc.id = p.host_test_case_id
     inner join features f on f.id = tc.feature_id
     where f.project_id = $1::uuid`,
    [projectId],
  );
  const adj = new Map<string, string[]>();
  for (const row of r.rows) {
    const arr = adj.get(row.prereq) ?? [];
    arr.push(row.host);
    adj.set(row.prereq, arr);
  }
  return adj;
}

/**
 * Kiểm tra thay đổi tiên quyết của `hostTestCaseId` không tạo chu trình
 * trong đồ thị phụ thuộc của toàn dự án (cạnh prereq → host).
 */
export async function validatePrerequisiteChange(
  pool: Pool,
  projectId: string,
  hostTestCaseId: string,
  newPrerequisiteIds: string[],
): Promise<string | null> {
  const tcRows = await pool.query<{ id: string }>(
    `select tc.id::text as id
     from test_cases tc
     inner join features f on f.id = tc.feature_id
     where f.project_id = $1::uuid`,
    [projectId],
  );
  const tcSet = new Set(tcRows.rows.map((row) => row.id));
  if (!tcSet.has(hostTestCaseId)) {
    return "Test case không thuộc dự án.";
  }
  for (const p of newPrerequisiteIds) {
    if (!tcSet.has(p)) {
      return "Một gói tiên quyết không thuộc dự án.";
    }
    if (p === hostTestCaseId) {
      return "Không thể đặt chính testcase làm tiên quyết.";
    }
  }

  const adj = await loadPrerequisiteEdgesInProject(pool, projectId);

  const rOld = await pool.query<{ prerequisite_test_case_id: string }>(
    `select prerequisite_test_case_id
     from test_case_prerequisites
     where host_test_case_id = $1`,
    [hostTestCaseId],
  );
  for (const row of rOld.rows) {
    const prereq = row.prerequisite_test_case_id;
    const hosts = adj.get(prereq);
    if (!hosts) continue;
    const filtered = hosts.filter((h) => h !== hostTestCaseId);
    if (filtered.length === 0) {
      adj.delete(prereq);
    } else {
      adj.set(prereq, filtered);
    }
  }

  for (const prereq of newPrerequisiteIds) {
    const arr = adj.get(prereq) ?? [];
    arr.push(hostTestCaseId);
    adj.set(prereq, arr);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const state = new Map<string, number>();

  function hasCycleFrom(u: string): boolean {
    const st = state.get(u) ?? WHITE;
    if (st === GRAY) return true;
    if (st === BLACK) return false;
    state.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      if (hasCycleFrom(v)) return true;
    }
    state.set(u, BLACK);
    return false;
  }

  const vertices = new Set<string>();
  for (const [k, hosts] of adj) {
    vertices.add(k);
    for (const h of hosts) vertices.add(h);
  }

  for (const u of vertices) {
    if ((state.get(u) ?? WHITE) === WHITE && hasCycleFrom(u)) {
      return "Phát hiện vòng phụ thuộc giữa các gói / test case.";
    }
  }

  return null;
}

export async function replacePrerequisites(hostTestCaseId: string, orderedPrerequisiteIds: string[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from test_case_prerequisites where host_test_case_id = $1`, [hostTestCaseId]);
    for (let i = 0; i < orderedPrerequisiteIds.length; i++) {
      const pid = orderedPrerequisiteIds[i]!;
      await client.query(
        `insert into test_case_prerequisites(host_test_case_id, prerequisite_test_case_id, order_index)
         values ($1, $2, $3)`,
        [hostTestCaseId, pid, i],
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function getProjectIdForTestCaseId(pool: Pool, testCaseId: string): Promise<string | null> {
  const r = await pool.query<{ project_id: string }>(
    `select f.project_id::text as project_id
     from test_cases tc
     join features f on f.id = tc.feature_id
     where tc.id = $1`,
    [testCaseId],
  );
  return r.rows[0]?.project_id ?? null;
}
