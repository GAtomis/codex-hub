import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const rootDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(rootDir, "..", "apps", "hub-backend", "src", "schema.sql");
const pgUrl = process.env.PG_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const run = async () => {
  const client = new Client({ connectionString: pgUrl });
  const schema = await readFile(schemaPath, "utf8");

  await client.connect();
  await client.query(schema);
  await client.end();

  // eslint-disable-next-line no-console
  console.log("database schema initialized");
};

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("failed to initialize schema", error);
  process.exit(1);
});
