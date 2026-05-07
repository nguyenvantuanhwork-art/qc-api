import bcrypt from "bcryptjs";
import { getPool } from "../db";

/**
 * Migration idempotent (dev-friendly).
 * Khi sau này làm auth/authz, chuyển sang tool migration chính thức (drizzle/prisma/flyway).
 */
export async function migrate(): Promise<void> {
  const pool = getPool();

  // NOTE: Không gộp nhiều statement trong một query string.
  // Nếu DB đã có schema cũ (thiếu cột), 1 statement fail sẽ làm toàn bộ migrate "nửa vời".
  await pool.query(`create extension if not exists pgcrypto;`);

  // ---------- users (auth) ----------
  await pool.query(`
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      username text not null unique,
      password_hash text not null,
      role text not null check (role in ('admin', 'user')),
      created_at timestamptz not null default now()
    );
  `);

  // ---------- projects ----------
  await pool.query(`
    create table if not exists projects (
      id uuid primary key default gen_random_uuid(),
      key text unique,
      name text not null,
      description text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`alter table projects add column if not exists description text not null default '';`);
  await pool.query(`alter table projects add column if not exists created_at timestamptz not null default now();`);
  await pool.query(`alter table projects add column if not exists updated_at timestamptz not null default now();`);
  await pool.query(`
    alter table projects add column if not exists owner_user_id uuid references users(id) on delete cascade;
  `);
  await pool.query(`create index if not exists idx_projects_owner on projects(owner_user_id);`);
  await pool.query(`
    alter table projects add column if not exists settings jsonb not null default '{}'::jsonb;
  `);

  await pool.query(`
    create table if not exists project_members (
      project_id uuid not null references projects(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (project_id, user_id)
    );
  `);
  await pool.query(`create index if not exists idx_project_members_user on project_members(user_id);`);

  // ---------- project_groups ----------
  await pool.query(`
    create table if not exists project_groups (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      name text not null,
      description text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (project_id, name)
    );
  `);
  await pool.query(`create index if not exists idx_project_groups_project on project_groups(project_id);`);

  await pool.query(`
    create table if not exists project_group_members (
      group_id uuid not null references project_groups(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (group_id, user_id)
    );
  `);
  await pool.query(`create index if not exists idx_project_group_members_user on project_group_members(user_id);`);

  // ---------- user_notifications (in-app) ----------
  await pool.query(`
    create table if not exists user_notifications (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      kind text not null,
      title text not null,
      body text not null default '',
      payload jsonb not null default '{}'::jsonb,
      read_at timestamptz,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(
    `create index if not exists idx_user_notifications_user_created on user_notifications(user_id, created_at desc);`,
  );
  await pool.query(
    `create index if not exists idx_user_notifications_unread on user_notifications(user_id) where read_at is null;`,
  );

  // ---------- Cài đặt toàn cục (một hàng) ----------
  await pool.query(`
    create table if not exists app_settings (
      id smallint primary key check (id = 1),
      registration_open boolean not null default true,
      maintenance_banner text not null default ''
    );
  `);
  await pool.query(
    `insert into app_settings (id, registration_open, maintenance_banner) values (1, true, '') on conflict (id) do nothing`,
  );

  // ---------- features ----------
  await pool.query(`
    create table if not exists features (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null,
      key text,
      name text not null,
      description text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    alter table features
      add column if not exists project_id uuid;
  `);
  await pool.query(`alter table features add column if not exists description text not null default '';`);
  await pool.query(`alter table features add column if not exists created_at timestamptz not null default now();`);
  await pool.query(`alter table features add column if not exists updated_at timestamptz not null default now();`);

  // FK + unique (đặt trong DO để tránh crash nếu đã tồn tại/khác tên)
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'features_project_id_fkey'
      ) then
        alter table features
          add constraint features_project_id_fkey
          foreign key (project_id) references projects(id) on delete cascade;
      end if;
    exception when others then
      -- ignore (dev-friendly)
    end $$;
  `);
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'features_project_key_unique'
      ) then
        alter table features add constraint features_project_key_unique unique(project_id, key);
      end if;
    exception when others then
    end $$;
  `);

  // ---------- test_cases ----------
  await pool.query(`
    create table if not exists test_cases (
      id text primary key,
      feature_id uuid,
      key text,
      name text not null,
      description text not null default '',
      status text not null default 'active',
      priority text not null default 'medium',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  // Nếu DB cũ thiếu feature_id -> add, nhưng không fail nếu đã có.
  await pool.query(`alter table test_cases add column if not exists feature_id uuid;`);
  await pool.query(`alter table test_cases add column if not exists description text not null default '';`);
  await pool.query(`alter table test_cases add column if not exists status text not null default 'active';`);
  await pool.query(`alter table test_cases add column if not exists priority text not null default 'medium';`);
  await pool.query(`alter table test_cases add column if not exists created_at timestamptz not null default now();`);
  await pool.query(`alter table test_cases add column if not exists updated_at timestamptz not null default now();`);

  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'test_cases_feature_id_fkey'
      ) then
        alter table test_cases
          add constraint test_cases_feature_id_fkey
          foreign key (feature_id) references features(id) on delete set null;
      end if;
    exception when others then
    end $$;
  `);

  // ---------- project_group_assignments ----------
  // (đặt sau features + test_cases để tránh FK fail)
  await pool.query(`
    create table if not exists project_group_feature_assignments (
      group_id uuid not null references project_groups(id) on delete cascade,
      feature_id uuid not null references features(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (group_id, feature_id)
    );
  `);
  await pool.query(
    `create index if not exists idx_project_group_feature_assignments_group on project_group_feature_assignments(group_id);`,
  );
  await pool.query(
    `create index if not exists idx_project_group_feature_assignments_feature on project_group_feature_assignments(feature_id);`,
  );

  await pool.query(`
    create table if not exists project_group_test_case_assignments (
      group_id uuid not null references project_groups(id) on delete cascade,
      test_case_id text not null references test_cases(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (group_id, test_case_id)
    );
  `);
  await pool.query(
    `create index if not exists idx_project_group_test_case_assignments_group on project_group_test_case_assignments(group_id);`,
  );
  await pool.query(
    `create index if not exists idx_project_group_test_case_assignments_tc on project_group_test_case_assignments(test_case_id);`,
  );

  await pool.query(`
    create table if not exists project_group_tc_progress (
      group_id uuid not null references project_groups(id) on delete cascade,
      test_case_id text not null references test_cases(id) on delete cascade,
      completed boolean not null default false,
      note text not null default '',
      updated_at timestamptz not null default now(),
      primary key (group_id, test_case_id)
    );
  `);
  await pool.query(
    `create index if not exists idx_project_group_tc_progress_tc on project_group_tc_progress(test_case_id);`,
  );

  // ---------- test_actions ----------
  await pool.query(`
    create table if not exists test_actions (
      id uuid primary key default gen_random_uuid(),
      test_case_id text not null,
      order_index integer not null,
      kind text not null,
      name text not null,
      enabled boolean not null default true,
      config jsonb not null default '{}'::jsonb,
      expectation text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`alter table test_actions add column if not exists expectation text not null default '';`);
  await pool.query(`alter table test_actions add column if not exists created_at timestamptz not null default now();`);
  await pool.query(`alter table test_actions add column if not exists updated_at timestamptz not null default now();`);

  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'test_actions_test_case_id_fkey'
      ) then
        alter table test_actions
          add constraint test_actions_test_case_id_fkey
          foreign key (test_case_id) references test_cases(id) on delete cascade;
      end if;
    exception when others then
    end $$;
  `);
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'test_actions_case_order_unique'
      ) then
        alter table test_actions add constraint test_actions_case_order_unique unique(test_case_id, order_index);
      end if;
    exception when others then
    end $$;
  `);

  // Indexes (không fail nếu cột đã ok, nếu chưa thì add column ở trên đã lo)
  await pool.query(
    `create index if not exists idx_test_actions_case_order on test_actions(test_case_id, order_index);`,
  );

  // Một số DB production từng thêm CHECK trên `test_actions.kind` chỉ cho các kind cũ —
  // khiến insert/update `click_id`, `type_name`, … bị lỗi. Gỡ mọi CHECK có đề cập `kind`.
  await pool.query(`
    do $$
    declare r record;
    begin
      for r in
        select c.conname
        from pg_constraint c
        join pg_class t on c.conrelid = t.oid
        where t.relname = 'test_actions'
          and c.contype = 'c'
          and pg_get_constraintdef(c.oid) ilike '%kind%'
      loop
        execute format('alter table test_actions drop constraint if exists %I', r.conname);
      end loop;
    end $$;
  `);

  await pool.query(`create index if not exists idx_features_project on features(project_id);`);
  await pool.query(`create index if not exists idx_test_cases_feature on test_cases(feature_id);`);

  // ---------- Gói thao tác: tiên quyết + metadata đóng gói ----------
  await pool.query(`alter table test_cases add column if not exists is_operation_package boolean not null default false;`);
  await pool.query(
    `alter table test_cases add column if not exists packed_by_user_id uuid references users(id) on delete set null;`,
  );
  await pool.query(`alter table test_cases add column if not exists packed_at timestamptz;`);
  await pool.query(`alter table test_cases add column if not exists packed_from_test_case_id text;`);

  await pool.query(`
    create table if not exists test_case_prerequisites (
      host_test_case_id text not null references test_cases(id) on delete cascade,
      prerequisite_test_case_id text not null references test_cases(id) on delete cascade,
      order_index integer not null,
      primary key (host_test_case_id, order_index),
      constraint test_case_prerequisites_host_prereq_unique unique (host_test_case_id, prerequisite_test_case_id),
      constraint test_case_prerequisites_no_self check (host_test_case_id <> prerequisite_test_case_id)
    );
  `);
  await pool.query(
    `create index if not exists idx_test_case_prerequisites_prereq on test_case_prerequisites(prerequisite_test_case_id);`,
  );

  // ---------- test_runs (history) ----------
  await pool.query(`
    create table if not exists test_runs (
      id uuid primary key default gen_random_uuid(),
      test_case_id text not null,
      started_at timestamptz not null default now(),
      finished_at timestamptz not null default now(),
      duration_ms integer not null default 0,
      overall_status text not null default 'failed',
      result jsonb not null default '{}'::jsonb
    );
  `);
  await pool.query(`alter table test_runs add column if not exists started_at timestamptz not null default now();`);
  await pool.query(`alter table test_runs add column if not exists finished_at timestamptz not null default now();`);
  await pool.query(`alter table test_runs add column if not exists duration_ms integer not null default 0;`);
  await pool.query(`alter table test_runs add column if not exists overall_status text not null default 'failed';`);
  await pool.query(`alter table test_runs add column if not exists result jsonb not null default '{}'::jsonb;`);

  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'test_runs_test_case_id_fkey'
      ) then
        alter table test_runs
          add constraint test_runs_test_case_id_fkey
          foreign key (test_case_id) references test_cases(id) on delete cascade;
      end if;
    exception when others then
    end $$;
  `);
  await pool.query(
    `create index if not exists idx_test_runs_case_finished on test_runs(test_case_id, finished_at desc);`,
  );
  await pool.query(`
    alter table test_runs add column if not exists triggered_by_user_id uuid references users(id) on delete set null;
  `);
  await pool.query(
    `create index if not exists idx_test_runs_triggered_by on test_runs(triggered_by_user_id);`,
  );
  await pool.query(
    `create index if not exists idx_test_runs_finished_at on test_runs (finished_at desc);`,
  );

  await pool.query(`
    create table if not exists scheduled_test_runs (
      id uuid primary key default gen_random_uuid(),
      test_case_id text not null references test_cases(id) on delete cascade,
      created_by_user_id uuid references users(id) on delete set null,
      name text not null default '',
      cron_expression text not null,
      timezone text not null default 'Asia/Ho_Chi_Minh',
      enabled boolean not null default true,
      last_run_at timestamptz,
      next_run_at timestamptz,
      last_error text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(
    `create index if not exists idx_schedules_next on scheduled_test_runs (next_run_at) where enabled = true;`,
  );
  await pool.query(
    `create index if not exists idx_schedules_test_case on scheduled_test_runs (test_case_id);`,
  );
  await pool.query(
    `alter table scheduled_test_runs add column if not exists schedule_group_id uuid;`,
  );
  await pool.query(
    `alter table scheduled_test_runs add column if not exists stagger_seconds integer not null default 0;`,
  );
  await pool.query(
    `create index if not exists idx_schedules_group on scheduled_test_runs (schedule_group_id) where schedule_group_id is not null;`,
  );

  // Seed tài khoản mặc định (chỉ insert nếu chưa có — không ghi đè mật khẩu khi migrate lại)
  const adminHash = await bcrypt.hash("admin", 10);
  const userHash = await bcrypt.hash("user", 10);
  await pool.query(
    `insert into users(username, password_hash, role) values ($1, $2, 'admin') on conflict (username) do nothing`,
    ["admin", adminHash],
  );
  await pool.query(
    `insert into users(username, password_hash, role) values ($1, $2, 'user') on conflict (username) do nothing`,
    ["user", userHash],
  );
  const user2Hash = await bcrypt.hash("user2", 10);
  await pool.query(
    `insert into users(username, password_hash, role) values ($1, $2, 'user') on conflict (username) do nothing`,
    ["user2", user2Hash],
  );

  const idRows = await pool.query<{ id: string; username: string }>(
    `select id::text as id, username from users where username in ('admin','user')`,
  );
  const adminId = idRows.rows.find((r) => r.username === "admin")?.id;
  const demoUserId = idRows.rows.find((r) => r.username === "user")?.id;
  if (!adminId || !demoUserId) {
    console.warn("[db:migrate] Thiếu user admin/user sau seed — bỏ qua seed project.");
  } else {
  // Gán owner mặc định cho project cũ (chưa có owner)
  await pool.query(`update projects set owner_user_id = $1 where owner_user_id is null`, [adminId]);

  // ---------- Demo Web (admin) + tc-001 Acnecare ----------
  const seededProject = await pool.query<{ id: string }>(
    `
    insert into projects(key, name, description, owner_user_id)
    values ('demo-web', 'Demo Web', 'Dự án demo để thử TestFlow', $1)
    on conflict (key) do update set
      name = excluded.name,
      owner_user_id = coalesce(projects.owner_user_id, excluded.owner_user_id)
    returning id
  `,
    [adminId],
  );
  const projectId = seededProject.rows[0]?.id;
  if (projectId) {
    const seededFeature = await pool.query<{ id: string }>(
      `
      insert into features(project_id, key, name, description)
      values ($1, 'dang-nhap', 'Đăng nhập', 'Luồng đăng nhập')
      on conflict (project_id, key) do update set name=excluded.name
      returning id
    `,
      [projectId],
    );
    const featureId = seededFeature.rows[0]?.id;

    await pool.query(
      `
      insert into test_cases(id, feature_id, key, name, description, status, priority)
      values ($1, $2, 'TC-001', $3, 'Kiểm tra luồng đăng nhập với tài khoản hợp lệ.', 'active', 'high')
      on conflict (id) do update set feature_id=excluded.feature_id, name=excluded.name
    `,
      ["tc-001", featureId ?? null, "TC-001 - Đăng nhập thành công"],
    );
  } else {
    await pool.query(
      `
      insert into test_cases(id, name)
      values ($1, $2)
      on conflict (id) do nothing
    `,
      ["tc-001", "TC-001 - Đăng nhập thành công"],
    );
  }

  const existing = await pool.query<{ count: string }>(
    `select count(*)::text as count from test_actions where test_case_id=$1`,
    ["tc-001"],
  );
  if (Number(existing.rows[0]?.count ?? "0") === 0) {
    await pool.query(
      `
      insert into test_actions(test_case_id, order_index, kind, name, enabled, config, expectation)
      values
        ($1, 0, 'navigate', 'Mở trang Acnecare', true, jsonb_build_object('url','https://acnecare.io.vn'), ''),
        ($1, 1, 'wait', 'Chờ tải trang', true, jsonb_build_object('waitMs', 2000), ''),
        ($1, 2, 'click_text', 'Click Đăng nhập', true, jsonb_build_object('matchText','đăng nhập'), 'Mở được form / trang đăng nhập'),
        ($1, 3, 'wait', 'Chờ sau click', true, jsonb_build_object('waitMs', 1500), '')
    `,
      ["tc-001"],
    );
  }

  // ---------- Google search demo (user / user) ----------
  const gProj = await pool.query<{ id: string }>(
    `
    insert into projects(key, name, description, owner_user_id)
    values ('google-search-demo', 'Google tìm kiếm', 'Demo tìm kiếm trên google.com', $1)
    on conflict (key) do update set
      name = excluded.name,
      description = excluded.description,
      owner_user_id = coalesce(projects.owner_user_id, excluded.owner_user_id)
    returning id
  `,
    [demoUserId],
  );
  const gProjectId = gProj.rows[0]?.id;
  if (gProjectId) {
    const gFeat = await pool.query<{ id: string }>(
      `
      insert into features(project_id, key, name, description)
      values ($1, 'tim-kiem', 'Tìm kiếm', 'Gõ từ khóa trên Google')
      on conflict (project_id, key) do update set name=excluded.name
      returning id
    `,
      [gProjectId],
    );
    const gFeatureId = gFeat.rows[0]?.id;
    if (gFeatureId) {
      await pool.query(
        `
        insert into test_cases(id, feature_id, key, name, description, status, priority)
        values ($1, $2, 'TC-GOOGLE-001', $3, 'Mở Google và nhập từ khóa tìm kiếm.', 'active', 'medium')
        on conflict (id) do update set feature_id=excluded.feature_id, name=excluded.name
      `,
        ["tc-google-search", gFeatureId, "Google — nhập từ khóa"],
      );
    }
  }

  const gActions = await pool.query<{ count: string }>(
    `select count(*)::text as count from test_actions where test_case_id=$1`,
    ["tc-google-search"],
  );
  if (Number(gActions.rows[0]?.count ?? "0") === 0) {
    await pool.query(
      `
      insert into test_actions(test_case_id, order_index, kind, name, enabled, config, expectation)
      values
        ($1, 0, 'navigate', 'Mở Google', true, jsonb_build_object('url','https://www.google.com'), ''),
        ($1, 1, 'wait', 'Chờ trang (cookie/consent)', true, jsonb_build_object('waitMs', 3000), ''),
        ($1, 2, 'type', 'Gõ từ khóa', true,
          jsonb_build_object('selector', 'textarea[name="q"]', 'value', 'qc test automation'),
          'Ô tìm kiếm hiển thị nội dung đã gõ'),
        ($1, 3, 'wait', 'Chờ sau khi gõ', true, jsonb_build_object('waitMs', 1000), '')
    `,
      ["tc-google-search"],
    );
  }
  }
}

