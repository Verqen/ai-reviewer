import { describe, expect, it } from "vitest";

import { Context7ConfigSchema } from "~/config/context7.config";

describe("Context7ConfigSchema", () => {
  it("is enabled when the flag is unset", () => {
    expect(Context7ConfigSchema.parse({}).CONTEXT7_ENABLED).toBe(true);
  });

  it("is disabled only by the exact false spelling", () => {
    expect(
      Context7ConfigSchema.parse({ CONTEXT7_ENABLED: "false" })
        .CONTEXT7_ENABLED,
    ).toBe(false);
  });

  it.each(["0", "no", "off", "disabled", ""])(
    "refuses %o instead of reading it as enabled",
    (value) => {
      expect(
        Context7ConfigSchema.safeParse({ CONTEXT7_ENABLED: value }).success,
      ).toBe(false);
    },
  );
});
