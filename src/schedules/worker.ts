import { getPool } from "../db";
import { executeTestCaseRun } from "../testCaseActions/executeRun";
import { computeNextRunAtIso, isOneShotCronExpression } from "./cronUtils";

/** Khoảng quét lịch (ms). 15s để lịch “sau N phút” gần đúng thời điểm hơn so với 60s. */
const SCHEDULE_POLL_MS = 15_000;

/** Lấy đủ lịch đến hạn để xử lý cả nhóm (nhiều testcase / stagger). */
const DUE_SCHEDULES_LIMIT = 64;

type DueScheduleRow = {
  id: string;
  test_case_id: string;
  cron_expression: string;
  timezone: string;
  created_by_user_id: string | null;
  schedule_group_id: string | null;
  stagger_seconds: number;
  next_run_at_key: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clusterKey(r: DueScheduleRow): string {
  if (!r.schedule_group_id) return `single:${r.id}`;
  return `grp:${r.schedule_group_id}|${r.next_run_at_key}`;
}

async function finalizeScheduleRun(
  pool: ReturnType<typeof getPool>,
  row: DueScheduleRow,
): Promise<void> {
  const triggeredBy = row.created_by_user_id?.trim() || null;
  const oneShot = isOneShotCronExpression(row.cron_expression);
  const ex = await executeTestCaseRun(row.test_case_id, triggeredBy, { source: "schedule" });
  const runErr = ex.ok ? "" : (ex.error ?? "Lỗi chạy");
  console.log(
    `[schedules:worker] schedule=${row.id} testCase=${row.test_case_id} ok=${ex.ok}${runErr ? ` err=${runErr.slice(0, 120)}` : ""}`,
  );
  if (oneShot) {
    const lastError = [runErr].filter(Boolean).join(" | ");
    await pool.query(
      `
      update scheduled_test_runs
      set last_run_at = now(),
          last_error = $2,
          next_run_at = null,
          enabled = false,
          updated_at = now()
      where id = $1::uuid
    `,
      [row.id, lastError],
    );
    return;
  }
  let nextIso = computeNextRunAtIso(row.cron_expression, row.timezone, new Date());
  let cronErr = "";
  if (!nextIso) {
    nextIso = new Date(Date.now() + 3_600_000).toISOString();
    cronErr = "Không tính được lần chạy tiếp theo (cron/múi giờ) — dùng tạm +1h.";
  }
  const lastError = [runErr, cronErr].filter(Boolean).join(" | ");
  await pool.query(
    `
    update scheduled_test_runs
    set last_run_at = now(),
        last_error = $2,
        next_run_at = $3::timestamptz,
        updated_at = now()
    where id = $1::uuid
  `,
    [row.id, lastError, nextIso],
  );
}

/**
 * Xử lý các lịch đến hạn. Một instance qc-api — đủ cho môi trường dev/single-node.
 * Các dòng cùng schedule_group_id và cùng next_run_at được chạy tuần tự,
 * cách nhau (stagger_seconds[i] - stagger_seconds[i-1]) giây.
 */
export async function processDueSchedules(): Promise<void> {
  const pool = getPool();
  const q = await pool.query<DueScheduleRow>(
    `
    select id::text,
           test_case_id,
           cron_expression,
           timezone,
           created_by_user_id::text as created_by_user_id,
           schedule_group_id::text as schedule_group_id,
           stagger_seconds::int as stagger_seconds,
           to_char(next_run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as next_run_at_key
    from scheduled_test_runs
    where enabled = true
      and next_run_at is not null
      and next_run_at <= now()
    order by next_run_at asc, stagger_seconds asc
    limit ${DUE_SCHEDULES_LIMIT}
  `,
  );

  if (q.rows.length > 0) {
    console.log(`[schedules:worker] ${q.rows.length} lịch đến hạn`);
  }

  const clusterMap = new Map<string, DueScheduleRow[]>();
  for (const r of q.rows) {
    const k = clusterKey(r);
    if (!clusterMap.has(k)) clusterMap.set(k, []);
    clusterMap.get(k)!.push(r);
  }

  const orderedClusters = [...clusterMap.entries()].sort((a, b) =>
    a[1][0].next_run_at_key.localeCompare(b[1][0].next_run_at_key),
  );

  for (const [, members] of orderedClusters) {
    members.sort((a, b) => a.stagger_seconds - b.stagger_seconds);
    for (let i = 0; i < members.length; i++) {
      if (i > 0) {
        const gapSec = members[i].stagger_seconds - members[i - 1].stagger_seconds;
        if (gapSec > 0) await sleep(gapSec * 1000);
      }
      await finalizeScheduleRun(pool, members[i]);
    }
  }
}

export function startScheduleRunner(): void {
  const tick = () => {
    processDueSchedules().catch((e) =>
      console.error("[schedules:worker]", e instanceof Error ? e.message : e),
    );
  };
  setInterval(tick, SCHEDULE_POLL_MS);
  setTimeout(tick, 2_500);
}
