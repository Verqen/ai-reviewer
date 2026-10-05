import { describe, expect, it } from "vitest";

import { PublicScanConfigSchema } from "~/config/public-scan.config";

describe("PublicScanConfigSchema", () => {
  it("caps a run at 0.5 USD when the ceiling is unset or blank", () => {
    expect(PublicScanConfigSchema.parse({}).PUBLIC_SCAN_MAX_COST_USD).toBe(0.5);
    expect(
      PublicScanConfigSchema.parse({ PUBLIC_SCAN_MAX_COST_USD: " " })
        .PUBLIC_SCAN_MAX_COST_USD,
    ).toBe(0.5);
  });

  it("reads a positive ceiling and refuses zero or a negative one", () => {
    expect(
      PublicScanConfigSchema.parse({ PUBLIC_SCAN_MAX_COST_USD: "1.25" })
        .PUBLIC_SCAN_MAX_COST_USD,
    ).toBe(1.25);
    expect(() =>
      PublicScanConfigSchema.parse({ PUBLIC_SCAN_MAX_COST_USD: "0" }),
    ).toThrow();
    expect(() =>
      PublicScanConfigSchema.parse({ PUBLIC_SCAN_MAX_COST_USD: "-1" }),
    ).toThrow();
  });

  it("needs no GitHub token", () => {
    expect(PublicScanConfigSchema.parse({}).GITHUB_TOKEN).toBeUndefined();
  });
});
