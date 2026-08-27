import { z } from "zod";

function optionalEnv<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodOptional<T>> {
  return z
    .transform((value: unknown) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    )
    .pipe(schema.optional());
}

export { optionalEnv };
