import { randomUUID } from "node:crypto";
import { getPool } from "../db";
import type { AuthPayload } from "../auth/types";
import { assertTestCaseAccess } from "../auth/access";
import { computeNextRunAtIso } from "./cronUtils";
import type { ScheduleListRow } from "./types";

export async function listSchedules(auth: AuthPayload): Promise<ScheduleListRow[]> {
  const pool = getPool();
  const isAdmin = auth.role === "admin";
  const q = await pool.query(
    `
    select
      s.id::text as id,
      s.test_case_id as "testCaseId",
      s.name,
      s.cron_expression as "cronExpression",
      s.timezone,
      s.enabled,
      s.last_run_at as "lastRunAt",
      s.next_run_at as "nextRunAt",
      s.last_error as "lastError",
      s.created_at as "createdAt",
      s.schedule_group_id::text as "scheduleGroupId",
      s.stagger_seconds as "staggerSeconds",
      tc.name as "testCaseName",
      f.id::text as "featureId",
      f.name as "featureName",
      p.id::text as "projectId",
      p.name as "projectName"
    from scheduled_test_runs s
    inner join test_cases tc on tc.id = s.test_case_id
    left join features f on f.id = tc.feature_id
    left join projects p on p.id = f.project_id
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
    order by s.next_run_at asc nulls last, s.created_at desc
  `,
    [isAdmin, auth.userId],
  );
  return q.rows as ScheduleListRow[];
}

export async function getScheduleById(scheduleId: string): Promise<{
  id: string;
  testCaseId: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  name: string;
  nextRunAt: string | null;
} | null> {
  const pool = getPool();
  const q = await pool.query<{
    id: string;
    test_case_id: string;
    cron_expression: string;
    timezone: string;
    enabled: boolean;
    name: string;
    nextRunAt: string | null;
  }>(
    `select id::text, test_case_id, cron_expression, timezone, enabled, name,
            next_run_at as "nextRunAt"
     from scheduled_test_runs where id = $1`,
    [scheduleId],
  );
  const r = q.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    testCaseId: r.test_case_id,
    cronExpression: r.cron_expression,
    timezone: r.timezone,
    enabled: r.enabled,
    name: r.name,
    nextRunAt: r.nextRunAt,
  };
}

export async function createSchedule(
  auth: AuthPayload,
  input: {
    testCaseId: string;
    name: string;
    cronExpression: string;
    timezone: string;
    enabled: boolean;
  },
): Promise<ScheduleListRow | null> {
  const pool = getPool();
  const ok = await assertTestCaseAccess(pool, auth, input.testCaseId);
  if (!ok) return null;

  const nextIso = computeNextRunAtIso(input.cronExpression, input.timezone);
  if (!nextIso) return null;

  const q = await pool.query(
    `
    insert into scheduled_test_runs(
      test_case_id, created_by_user_id, name, cron_expression, timezone, enabled, next_run_at
    )
    values ($1, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
    returning id::text
  `,
    [
      input.testCaseId,
      auth.userId,
      input.name.trim() || "Lịch chạy",
      input.cronExpression.trim(),
      input.timezone.trim() || "Asia/Ho_Chi_Minh",
      input.enabled,
      nextIso,
    ],
  );
  const id = q.rows[0]?.id as string | undefined;
  if (!id) return null;
  const rows = await listSchedules(auth);
  return rows.find((r) => r.id === id) ?? null;
}

/**
 * Tạo nhiều lịch cùng biểu thức cron; các testcase trong một lần tạo được gán schedule_group_id
 * và stagger_seconds lũy tiến để worker chạy lần lượt, cách nhau một khoảng giây.
 */
export async function createBulkSchedules(
  auth: AuthPayload,
  input: {
    testCaseIds: string[];
    namePrefix: string;
    cronExpression: string;
    timezone: string;
    enabled: boolean;
    staggerSeconds: number;
  },
): Promise<ScheduleListRow[]> {
  const raw = input.testCaseIds.map((x) => String(x).trim()).filter(Boolean);
  const ids = [...new Set(raw)];
  if (ids.length === 0) return [];

  const pool = getPool();
  for (const id of ids) {
    const ok = await assertTestCaseAccess(pool, auth, id);
    if (!ok) return [];
  }

  const cronExpression = input.cronExpression.trim();
  const timezone = input.timezone.trim() || "Asia/Ho_Chi_Minh";
  const nextIso = computeNextRunAtIso(cronExpression, timezone);
  if (!nextIso) return [];

  const namePrefix = input.namePrefix.trim() || "Lịch chạy";
  const staggerStep = Math.min(86_400, Math.max(0, Math.floor(Number(input.staggerSeconds) || 0)));
  const groupId = ids.length > 1 ? randomUUID() : null;

  const namesQ = await pool.query<{ id: string; name: string }>(
    `select id::text as id, name from test_cases where id = any($1::text[])`,
    [ids],
  );
  const nameById = new Map(namesQ.rows.map((r) => [r.id, r.name]));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < ids.length; i++) {
      const tcId = ids[i];
      const tcName = nameById.get(tcId)?.trim() || tcId;
      const rowName = ids.length === 1 ? namePrefix : `${namePrefix} — ${tcName}`;
      const stagger = ids.length > 1 ? i * staggerStep : 0;
      await client.query(
        `
        insert into scheduled_test_runs(
          test_case_id, created_by_user_id, name, cron_expression, timezone, enabled, next_run_at,
          schedule_group_id, stagger_seconds
        )
        values ($1, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8::uuid, $9)
      `,
        [
          tcId,
          auth.userId,
          rowName,
          cronExpression,
          timezone,
          input.enabled,
          nextIso,
          groupId,
          stagger,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return listSchedules(auth);
}

export async function updateSchedule(
  auth: AuthPayload,
  scheduleId: string,
  patch: Partial<{ name: string; cronExpression: string; timezone: string; enabled: boolean }>,
): Promise<ScheduleListRow | null> {
  const pool = getPool();
  const existing = await getScheduleById(scheduleId);
  if (!existing) return null;
  const ok = await assertTestCaseAccess(pool, auth, existing.testCaseId);
  if (!ok) return null;

  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  const cronExpression =
    patch.cronExpression !== undefined ? patch.cronExpression.trim() : existing.cronExpression;
  const timezone = patch.timezone !== undefined ? patch.timezone.trim() : existing.timezone;
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;

  const cronUnchanged = patch.cronExpression === undefined && patch.timezone === undefined;
  const low = cronExpression.trim().toLowerCase();
  let nextIso = computeNextRunAtIso(cronExpression, timezone);
  if (!nextIso) return null;

  /* @in:N là “sau N phút khi lưu”; chỉ bật/tắt không được đẩy deadline bằng cách tính lại từ bây giờ. */
  if (cronUnchanged && low.startsWith("@in:") && existing.nextRunAt) {
    const keep = new Date(existing.nextRunAt);
    if (keep.getTime() > Date.now()) {
      nextIso = keep.toISOString();
    }
  }

  await pool.query(
    `
    update scheduled_test_runs
    set name = $2,
        cron_expression = $3,
        timezone = $4,
        enabled = $5,
        next_run_at = $6::timestamptz,
        updated_at = now()
    where id = $1::uuid
  `,
    [scheduleId, name || "Lịch chạy", cronExpression, timezone, enabled, nextIso],
  );
  const rows = await listSchedules(auth);
  return rows.find((r) => r.id === scheduleId) ?? null;
}

export async function deleteSchedule(auth: AuthPayload, scheduleId: string): Promise<boolean> {
  const pool = getPool();
  const existing = await getScheduleById(scheduleId);
  if (!existing) return false;
  const ok = await assertTestCaseAccess(pool, auth, existing.testCaseId);
  if (!ok) return false;
  const r = await pool.query(`delete from scheduled_test_runs where id = $1::uuid`, [scheduleId]);
  return (r.rowCount ?? 0) > 0;
}
