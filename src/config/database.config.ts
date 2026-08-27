import { Config } from "~/shared/config";
import { z } from "zod";

const DatabaseConfigSchema = z.object({
  DATABASE_URL: z.string(),
});

type DatabaseConfigSchema = z.infer<typeof DatabaseConfigSchema>;

class DatabaseConfig extends Config<DatabaseConfigSchema> {
  constructor(envs?: DatabaseConfigSchema) {
    super(() => envs ?? DatabaseConfigSchema.parse(process.env));
  }
}

export { DatabaseConfig, DatabaseConfigSchema };
