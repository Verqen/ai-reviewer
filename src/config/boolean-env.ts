import { z } from "zod";

type BooleanEnvSchema = z.ZodPipe<
  z.ZodDefault<z.ZodEnum<{ true: "true"; false: "false" }>>,
  z.ZodTransform<boolean, "true" | "false">
>;

function booleanEnv(defaultValue: boolean): BooleanEnvSchema {
  return z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");
}

export { booleanEnv };
export type { BooleanEnvSchema };
