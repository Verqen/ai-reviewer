import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRODUCT_NAME,
  resolveProductName,
} from "~/domain/product-name";

describe("resolveProductName", () => {
  it("falls back to the default for undefined, empty and blank values", () => {
    expect(resolveProductName(undefined)).toBe(DEFAULT_PRODUCT_NAME);
    expect(resolveProductName("")).toBe(DEFAULT_PRODUCT_NAME);
    expect(resolveProductName("  \t")).toBe(DEFAULT_PRODUCT_NAME);
  });

  it("returns a given name trimmed", () => {
    expect(resolveProductName(" Acme ")).toBe("Acme");
  });
});
