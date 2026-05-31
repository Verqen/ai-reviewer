import { describe, expect, it } from "vitest";

import { deriveWorkspaceFilterFromYamlDocument } from "~/application/parse-pnpm-workspace";

const FIXTURE_WORKSPACE_YAML = `packages:
  - apps/*
  - packages/**
  - services/*

catalog:
  zod: 4.0.14
  fastify: 5.5.0
`;

describe("deriveWorkspaceFilterFromYamlDocument", () => {
  it("returns active filter with distinct glob entries trimmed from workspace fixture", () => {
    const parseMarkedFailureTracked = { value: false };
    const actualGlobFilterApplied = deriveWorkspaceFilterFromYamlDocument(
      FIXTURE_WORKSPACE_YAML,
      parseMarkedFailureTracked,
    );
    expect(parseMarkedFailureTracked.value).toBe(false);
    expect(actualGlobFilterApplied.filterActiveForPackageRoots).toBe(true);
    expect(actualGlobFilterApplied.packageRootPathGlobs.slice(0, 3)).toEqual([
      "apps/*",
      "packages/**",
      "services/*",
    ]);
    expect(actualGlobFilterApplied.packageRootPathGlobs).not.toContain(
      "catalog:",
    );
  });

  it("does not activate filter when packages key yields only empty strings", () => {
    const parseMarkedFailureTracked = { value: false };
    const actualOutcome = deriveWorkspaceFilterFromYamlDocument(
      `
packages:
  - ""
`,
      parseMarkedFailureTracked,
    );
    expect(parseMarkedFailureTracked.value).toBe(false);
    expect(actualOutcome.filterActiveForPackageRoots).toBe(false);
    expect(actualOutcome.packageRootPathGlobs).toEqual([]);
  });

  it("marks parse intent when YAML is invalid syntax", () => {
    const parseMarkedFailureTracked = { value: false };
    const actualOutcomeBadSyntax = deriveWorkspaceFilterFromYamlDocument(
      `: [ broken`,
      parseMarkedFailureTracked,
    );
    expect(parseMarkedFailureTracked.value).toBe(true);
    expect(actualOutcomeBadSyntax.filterActiveForPackageRoots).toBe(false);
  });
});
