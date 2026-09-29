import { createHash } from "node:crypto";

import type { CatalogRule } from "~/domain/rule-catalog/rule-catalog.types";

function computeCatalogFingerprint(rules: readonly CatalogRule[]): string {
  const canonical = [...rules]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((rule) => [
      rule.id,
      rule.title,
      rule.condition,
      rule.finding,
      rule.detection,
      rule.severity,
      rule.category,
      rule.scope,
    ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export { computeCatalogFingerprint };
