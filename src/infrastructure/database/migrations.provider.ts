import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { FileMigrationProvider } from "kysely";

function createMigrationsProvider(): FileMigrationProvider {
  const filePath = fileURLToPath(import.meta.url);
  const directoryPath = path.dirname(filePath);
  const migrationFolder = path.join(directoryPath, "migrations");
  return new FileMigrationProvider({ fs, migrationFolder, path });
}

export { createMigrationsProvider };
