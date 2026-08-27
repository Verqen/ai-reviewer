import type {
  DismissedPattern,
  IDismissedPatternRepository,
} from "~/domain/ports/dismissed-pattern.repository.port";

function createMockDismissedPattern(
  overrides: Partial<DismissedPattern> = {},
): DismissedPattern {
  return {
    category: "bug",
    createdAt: new Date(0),
    id: "dismissed-pattern-1",
    occurrenceCount: 1,
    patternDescription: "dismissed pattern",
    projectId: 1,
    severity: "warning",
    updatedAt: new Date(0),
    ...overrides,
  };
}

function createMockDismissedPatternRepository(
  overrides: Partial<IDismissedPatternRepository> = {},
): IDismissedPatternRepository {
  return {
    create: () => Promise.resolve(createMockDismissedPattern()),
    findByProject: () => Promise.resolve([]),
    findSimilar: () => Promise.resolve(undefined),
    incrementOccurrence: () => Promise.resolve(),
    ...overrides,
  };
}

export { createMockDismissedPattern, createMockDismissedPatternRepository };
