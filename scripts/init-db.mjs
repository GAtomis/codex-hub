import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const rootDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(rootDir, "..");
const schemaPath = join(projectRoot, "apps", "hub-backend", "src", "schema.sql");
const defaultPgUrl = "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const stripQuotes = (value) => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

const loadEnvFile = async (path) => {
  try {
    const content = await readFile(path, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = stripQuotes(line.slice(separatorIndex + 1).trim());
      if (!key || process.env[key] !== undefined) {
        continue;
      }
      process.env[key] = value;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const run = async () => {
  await loadEnvFile(join(projectRoot, ".env.local"));
  await loadEnvFile(join(projectRoot, ".env"));

  const pgUrl = process.env.PG_URL ?? defaultPgUrl;
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
