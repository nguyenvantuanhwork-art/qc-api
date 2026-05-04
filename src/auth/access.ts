import type { Pool } from "pg";
import type { AuthPayload } from "./types";

/** Xem / chỉnh test trong dự án: admin, chủ dự án, hoặc thành viên. */
export async function assertProjectAccess(
  pool: Pool,
  auth: AuthPayload,
  projectId: string,
): Promise<boolean> {
  if (auth.role === "admin") {
    const r = await pool.query(`select 1 from projects where id=$1`, [projectId]);
    return (r.rowCount ?? 0) > 0;
  }
  const owner = await pool.query(`select 1 from projects where id=$1 and owner_user_id=$2`, [
    projectId,
    auth.userId,
  ]);
  if ((owner.rowCount ?? 0) > 0) return true;
  const mem = await pool.query(
    `select 1 from project_members where project_id=$1 and user_id=$2`,
    [projectId, auth.userId],
  );
  return (mem.rowCount ?? 0) > 0;
}

/** Đổi tên / xóa dự án, thêm xóa thành viên: chỉ admin hoặc chủ dự án. */
export async function assertProjectManage(
  pool: Pool,
  auth: AuthPayload,
  projectId: string,
): Promise<boolean> {
  if (auth.role === "admin") {
    const r = await pool.query(`select 1 from projects where id=$1`, [projectId]);
    return (r.rowCount ?? 0) > 0;
  }
  const r = await pool.query(`select 1 from projects where id=$1 and owner_user_id=$2`, [
    projectId,
    auth.userId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function assertFeatureInProject(
  pool: Pool,
  projectId: string,
  featureId: string,
): Promise<boolean> {
  const r = await pool.query(`select 1 from features where id=$1 and project_id=$2`, [
    featureId,
    projectId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function assertTestCaseAccess(
  pool: Pool,
  auth: AuthPayload,
  testCaseId: string,
): Promise<boolean> {
  if (auth.role === "admin") {
    const r = await pool.query(`select 1 from test_cases where id = $1`, [testCaseId]);
    return (r.rowCount ?? 0) > 0;
  }
  const r = await pool.query(
    `select 1
     from test_cases tc
     join features f on f.id = tc.feature_id
     join projects p on p.id = f.project_id
     where tc.id = $1
       and (
         p.owner_user_id = $2
         or exists (
           select 1 from project_members pm
           where pm.project_id = p.id and pm.user_id = $2
         )
       )`,
    [testCaseId, auth.userId],
  );
  return (r.rowCount ?? 0) > 0;
}
