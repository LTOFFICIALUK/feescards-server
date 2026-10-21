import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { required } from "./env.js";

export const sql = postgres(required("DATABASE_URL"), {
  max: 10,
  prepare: false,
  types: { bigint: postgres.BigInt },
});

export const migrate = async () => {
  const file = path.join(process.cwd(), "migrations", "001_init.sql");
  const script = fs.readFileSync(file, "utf8");
  await sql.unsafe(script);
};

export const withLock = async <T>(key: string, fn: () => Promise<T>) => {
  const rows = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${key})) AS locked`;
  if (!rows[0]?.locked) return null;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
  }
};
