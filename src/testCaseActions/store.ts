import type { ActionKind, ActionConfig, TestAction } from "./types";
import { getPool } from "../db";

export function validateConfig(kind: ActionKind, config: ActionConfig): string | null {
  switch (kind) {
    case "navigate":
      return config.url?.trim() ? null : "navigate cần config.url";
    case "click_selector":
      return config.selector?.trim() ? null : "click_selector cần config.selector";
    case "click_text":
      return config.matchText?.trim() ? null : "click_text cần config.matchText";
    case "click_id":
      return config.id?.trim() ? null : "click_id cần config.id";
    case "click_name":
      return config.name?.trim() ? null : "click_name cần config.name";
    case "click_xpath":
      return config.xpath?.trim() ? null : "click_xpath cần config.xpath";
    case "type":
      if (!config.selector?.trim()) return "type cần config.selector";
      if (config.value === undefined || config.value === null) return "type cần config.value";
      return null;
    case "type_id":
      if (!config.id?.trim()) return "type_id cần config.id";
      if (config.value === undefined || config.value === null) return "type_id cần config.value";
      return null;
    case "type_name":
      if (!config.name?.trim()) return "type_name cần config.name";
      if (config.value === undefined || config.value === null) return "type_name cần config.value";
      return null;
    case "type_xpath":
      if (!config.xpath?.trim()) return "type_xpath cần config.xpath";
      if (config.value === undefined || config.value === null) return "type_xpath cần config.value";
      return null;
    case "wait":
      if (config.waitMs === undefined || config.waitMs === null) return "wait cần config.waitMs";
      if (config.waitMs < 0 || config.waitMs > 120_000) return "waitMs trong khoảng 0–120000";
      return null;
    default:
      return "kind không hợp lệ";
  }
}

function rowToAction(row: any): TestAction {
  return {
    id: String(row.id),
    testCaseId: String(row.test_case_id),
    order: Number(row.order_index),
    kind: row.kind as ActionKind,
    name: String(row.name),
    enabled: Boolean(row.enabled),
    config: (row.config ?? {}) as ActionConfig,
    expectation: String(row.expectation ?? ""),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listActions(testCaseId: string): Promise<TestAction[]> {
  const pool = getPool();
  const r = await pool.query(
    `select * from test_actions where test_case_id=$1 order by order_index asc`,
    [testCaseId],
  );
  return r.rows.map(rowToAction);
}

export async function createAction(
  testCaseId: string,
  input: {
    name: string;
    kind: ActionKind;
    order?: number;
    enabled?: boolean;
    config: ActionConfig;
    expectation?: string;
  },
): Promise<{ action?: TestAction; error?: string }> {
  const err = validateConfig(input.kind, input.config);
  if (err) return { error: err };

  const pool = getPool();
  const name = input.name.trim() || input.kind;
  const enabled = input.enabled ?? true;
  const expectation = input.expectation?.trim() || "";

  // Nếu order không truyền, append cuối.
  const nextOrder =
    input.order !== undefined && Number.isFinite(input.order)
      ? Math.max(0, Math.floor(input.order))
      : undefined;

  const client = await pool.connect();
  try {
    await client.query("begin");

    let orderIndex: number;
    if (nextOrder === undefined) {
      const m = await client.query<{ max: number | null }>(
        `select max(order_index)::int as max from test_actions where test_case_id=$1`,
        [testCaseId],
      );
      orderIndex = (m.rows[0]?.max ?? -1) + 1;
    } else {
      orderIndex = nextOrder;
      // dồn các bước >= orderIndex xuống 1
      await client.query(
        `update test_actions set order_index = order_index + 1, updated_at=now()
         where test_case_id=$1 and order_index >= $2`,
        [testCaseId, orderIndex],
      );
    }

    const inserted = await client.query(
      `insert into test_actions(test_case_id, order_index, kind, name, enabled, config, expectation)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7)
       returning *`,
      [testCaseId, orderIndex, input.kind, name, enabled, JSON.stringify(input.config ?? {}), expectation],
    );

    await client.query("commit");
    return { action: rowToAction(inserted.rows[0]) };
  } catch (e) {
    await client.query("rollback");
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.release();
  }
}

export async function updateAction(
  testCaseId: string,
  actionId: string,
  patch: Partial<Pick<TestAction, "name" | "kind" | "order" | "config" | "expectation" | "enabled">>,
): Promise<{ action?: TestAction; error?: string }> {
  const pool = getPool();
  const cur = await pool.query(`select * from test_actions where test_case_id=$1 and id=$2`, [
    testCaseId,
    actionId,
  ]);
  if (cur.rowCount === 0) return { error: "Không tìm thấy hành động" };
  const current = rowToAction(cur.rows[0]);

  const nextKind = patch.kind ?? current.kind;
  const nextConfig = patch.config ?? current.config;
  const err = validateConfig(nextKind, nextConfig);
  if (err) return { error: err };

  const name = patch.name !== undefined ? patch.name.trim() || current.name : current.name;
  const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled;
  const expectation =
    patch.expectation !== undefined ? patch.expectation.trim() : current.expectation ?? "";

  // order đổi -> reorderActions sẽ xử lý tốt hơn; ở đây chỉ update order_index nếu được truyền.
  const orderIndex = patch.order !== undefined ? Math.max(0, Math.floor(patch.order)) : current.order;

  const updated = await pool.query(
    `update test_actions
     set order_index=$3, kind=$4, name=$5, enabled=$6, config=$7::jsonb, expectation=$8, updated_at=now()
     where test_case_id=$1 and id=$2
     returning *`,
    [
      testCaseId,
      actionId,
      orderIndex,
      nextKind,
      name,
      enabled,
      JSON.stringify(nextConfig ?? {}),
      expectation,
    ],
  );
  return { action: rowToAction(updated.rows[0]) };
}

export async function deleteAction(testCaseId: string, actionId: string): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query(`delete from test_actions where test_case_id=$1 and id=$2`, [
    testCaseId,
    actionId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function reorderActions(
  testCaseId: string,
  orderedIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  const pool = getPool();
  const current = await pool.query<{ id: string }>(
    `select id::text as id from test_actions where test_case_id=$1`,
    [testCaseId],
  );
  if (orderedIds.length !== current.rowCount) {
    return { ok: false, error: "Số id không khớp số hành động hiện có" };
  }
  const set = new Set(current.rows.map((r) => r.id));
  for (const id of orderedIds) {
    if (!set.has(id)) return { ok: false, error: `Id không hợp lệ: ${id}` };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    // set về vùng tạm để tránh unique(test_case_id, order_index) conflict
    await client.query(
      `update test_actions set order_index = order_index + 1000000, updated_at=now() where test_case_id=$1`,
      [testCaseId],
    );
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `update test_actions set order_index=$3, updated_at=now() where test_case_id=$1 and id=$2`,
        [testCaseId, orderedIds[i], i],
      );
    }
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.release();
  }
}
