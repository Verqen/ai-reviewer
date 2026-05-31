import { Migrator } from "kysely";
import { pino } from "pino";

import { AppConfig } from "~/config/app.config";
import { DatabaseConfig } from "~/config/database.config";
import { createDatabase } from "~/infrastructure/database/database";
import { createMigrationsProvider } from "~/infrastructure/database/migrations.provider";

const logger = pino({ level: "info" });

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception in migration runner");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal(
    { err: toError(reason) },
    "Unhandled rejection in migration runner",
  );
  process.exit(1);
});

async function runMigrations(): Promise<void> {
  const appConfig = new AppConfig();
  logger.level = appConfig.envs.LOG_LEVEL;

  const config = new DatabaseConfig();
  const db = createDatabase(config.envs.DATABASE_URL);
  try {
    const migrator = new Migrator({
      db,
      provider: createMigrationsProvider(),
    });
    const { error, results } = await migrator.migrateToLatest();
    for (const result of results ?? []) {
      if (result.status === "Success") {
        logger.info(
          { migrationName: result.migrationName },
          "Migration applied successfully",
        );
      } else if (result.status === "Error") {
        logger.error(
          { migrationName: result.migrationName },
          "Migration failed",
        );
      }
    }
    if (error) {
      logger.fatal({ err: toError(error) }, "Migration runner aborted");
      process.exit(1);
    }
    logger.info("All migrations applied successfully");
  } finally {
    await db.destroy();
  }
}

void runMigrations();
