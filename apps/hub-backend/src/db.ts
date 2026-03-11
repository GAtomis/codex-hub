import { Pool } from "pg";
import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.pgUrl
});

const ensureProjectLifecycleColumns = async (): Promise<void> => {
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS retirement_mode TEXT`);
};

export const pingDb = async (): Promise<void> => {
  await pool.query("SELECT 1");
  await ensureProjectLifecycleColumns();
};
