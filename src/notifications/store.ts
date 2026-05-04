import { getPool } from "../db";

export type NotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export async function notifyTestRunFinished(args: {
  userId: string;
  testCaseId: string;
  runId: string;
  overallStatus: "passed" | "failed";
  durationMs: number;
}): Promise<void> {
  try {
    const pool = getPool();
    const ctx = await pool.query<{
      name: string;
      key: string | null;
      feature_id: string | null;
      project_id: string | null;
      project_name: string | null;
    }>(
      `
      select tc.name, tc.key, f.id::text as feature_id, p.id::text as project_id, p.name as project_name
      from test_cases tc
      left join features f on f.id = tc.feature_id
      left join projects p on p.id = f.project_id
      where tc.id = $1
      limit 1
    `,
      [args.testCaseId],
    );
    const row = ctx.rows[0];
    const label = row ? `${row.key ?? args.testCaseId} — ${row.name}` : args.testCaseId;
    const ok = args.overallStatus === "passed";
    const title = ok ? "Chạy test: PASSED" : "Chạy test: FAILED";
    const dur = (args.durationMs / 1000).toFixed(1);
    const body = `${label} · ${dur}s`;
    const payload = {
      testCaseId: args.testCaseId,
      featureId: row?.feature_id ?? null,
      runId: args.runId,
      overallStatus: args.overallStatus,
      projectId: row?.project_id ?? null,
      projectName: row?.project_name ?? null,
    };
    await pool.query(
      `
      insert into user_notifications(user_id, kind, title, body, payload)
      values ($1::uuid, 'test_run_finished', $2, $3, $4::jsonb)
    `,
      [args.userId, title, body, JSON.stringify(payload)],
    );
  } catch (e) {
    console.error("[notifications:test_run]", e instanceof Error ? e.message : e);
  }
}

export async function notifyProjectMemberAdded(args: {
  userId: string;
  projectId: string;
  projectName: string;
  invitedByUsername: string;
}): Promise<void> {
  try {
    const pool = getPool();
    const title = "Bạn được thêm vào dự án";
    const body = `${args.projectName} · mời bởi ${args.invitedByUsername}`;
    await pool.query(
      `
      insert into user_notifications(user_id, kind, title, body, payload)
      values ($1::uuid, 'project_member_added', $2, $3, $4::jsonb)
    `,
      [
        args.userId,
        title,
        body,
        JSON.stringify({
          projectId: args.projectId,
          projectName: args.projectName,
          invitedByUsername: args.invitedByUsername,
        }),
      ],
    );
  } catch (e) {
    console.error("[notifications:project_member]", e instanceof Error ? e.message : e);
  }
}

export async function listNotificationsForUser(
  userId: string,
  opts: { limit: number; unreadOnly: boolean },
): Promise<{ items: NotificationRow[]; unreadCount: number }> {
  const pool = getPool();
  const lim = Math.min(80, Math.max(1, Math.floor(opts.limit)));

  const cnt = await pool.query<{ n: string }>(
    `select count(*)::text as n from user_notifications where user_id = $1::uuid and read_at is null`,
    [userId],
  );
  const unreadCount = Number(cnt.rows[0]?.n ?? "0");

  const unreadClause = opts.unreadOnly ? `and un.read_at is null` : "";
  const q = await pool.query<{
    id: string;
    kind: string;
    title: string;
    body: string;
    payload: unknown;
    read_at: string | null;
    created_at: string;
  }>(
    `
    select un.id::text, un.kind, un.title, un.body, un.payload, un.read_at, un.created_at
    from user_notifications un
    where un.user_id = $1::uuid
    ${unreadClause}
    order by un.created_at desc
    limit $2
  `,
    [userId, lim],
  );

  const items: NotificationRow[] = q.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    payload: (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>,
    readAt: r.read_at,
    createdAt: r.created_at,
  }));

  return { items, unreadCount };
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query(
    `
    update user_notifications
    set read_at = now()
    where id = $1::uuid and user_id = $2::uuid and read_at is null
    returning id
  `,
    [notificationId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
    update user_notifications
    set read_at = now()
    where user_id = $1::uuid and read_at is null
  `,
    [userId],
  );
}
