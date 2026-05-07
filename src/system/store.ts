import type { Pool } from "pg";

export type AppSettingsRow = {
  registrationOpen: boolean;
  maintenanceBanner: string;
};

export async function loadAppSettings(pool: Pool): Promise<AppSettingsRow> {
  const r = await pool.query<{ registration_open: boolean; maintenance_banner: string }>(
    `select registration_open, maintenance_banner from app_settings where id = 1`,
  );
  const row = r.rows[0];
  if (!row) {
    return { registrationOpen: true, maintenanceBanner: "" };
  }
  return {
    registrationOpen: Boolean(row.registration_open),
    maintenanceBanner: typeof row.maintenance_banner === "string" ? row.maintenance_banner : "",
  };
}

export async function upsertAppSettings(
  pool: Pool,
  patch: { registrationOpen?: boolean; maintenanceBanner?: string | null },
): Promise<AppSettingsRow> {
  const cur = await loadAppSettings(pool);
  const next = {
    registrationOpen: patch.registrationOpen ?? cur.registrationOpen,
    maintenanceBanner:
      patch.maintenanceBanner !== undefined && patch.maintenanceBanner !== null
        ? patch.maintenanceBanner
        : cur.maintenanceBanner,
  };
  await pool.query(
    `insert into app_settings (id, registration_open, maintenance_banner)
     values (1, $1, $2)
     on conflict (id) do update set
       registration_open = excluded.registration_open,
       maintenance_banner = excluded.maintenance_banner`,
    [next.registrationOpen, next.maintenanceBanner],
  );
  return loadAppSettings(pool);
}
