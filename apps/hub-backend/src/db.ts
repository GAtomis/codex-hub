import { Pool } from "pg";
import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.pgUrl
});

export const pingDb = async (): Promise<void> => {
  await pool.query("SELECT 1");
};
