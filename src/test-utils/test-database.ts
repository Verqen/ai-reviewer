import { Migrator } from "kysely";
import type { Kysely } from "kysely";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";

import { createDatabase } from "~/infrastructure/database/database";
import { createMigrationsProvider } from "~/infrastructure/database/migrations.provider";
import type { Database } from "~/infrastructure/database/types";

interface TestDatabase {
  cleanup: () => Promise<void>;
  db: Kysely<Database>;
  wipe: () => Promise<void>;
}

async function createTestDatabase(): Promise<TestDatabase> {
  const container: StartedTestContainer = await new GenericContainer(
    "postgres:17-alpine",
  )
    .withEnvironment({
      POSTGRES_DB: "test_ai_reviewer",
      POSTGRES_PASSWORD: "test",
      POSTGRES_USER: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionUri = `postgres://test:test@${host}:${port}/test_ai_reviewer`;
  const db = createDatabase(connectionUri);
  const migrator = new Migrator({
    db,
    provider: createMigrationsProvider(),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    await container.stop();
    throw error instanceof Error ? error : new Error("Migration failed");
  }
  async function wipe(): Promise<void> {
    await db.deleteFrom("dismissed_pattern").execute();
    await db.deleteFrom("snapshot_entry").execute();
    await db.deleteFrom("snapshot_commit").execute();
    await db.deleteFrom("snapshot_blob").execute();
    await db.deleteFrom("baseline_state").execute();
    await db.deleteFrom("review_finding").execute();
    await db.deleteFrom("review_run").execute();
  }
  async function cleanup(): Promise<void> {
    await db.destroy();
    await container.stop();
  }
  return { cleanup, db, wipe };
}

export { createTestDatabase };
export type { TestDatabase };
