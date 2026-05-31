import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

import type { Database } from "~/infrastructure/database/types";

function createDatabase(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export { createDatabase };
