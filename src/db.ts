import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    pool = new Pool({ connectionString });
    return pool;
  }

  // Fallback cho máy dev: dùng bộ biến PG* nếu không set DATABASE_URL.
  // (Hợp với setup Postgres local đã có sẵn.)
  const host = process.env.PGHOST?.trim() || "localhost";
  const port = Number(process.env.PGPORT) || 5432;
  const user = process.env.PGUSER?.trim() || "postgres";
  const password = process.env.PGPASSWORD ?? "";
  const database = process.env.PGDATABASE?.trim() || "qc";

  if (!password) {
    throw new Error(
      "Thiếu DATABASE_URL hoặc PGPASSWORD. Ví dụ: postgres://postgres:admin@localhost:5432/qc (xem .env.example)",
    );
  }

  pool = new Pool({
    host,
    port,
    user,
    password,
    database,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

