import { describe, expect, it } from "vitest";

import { CostBudget } from "./cost-budget";

describe("CostBudget", () => {
  it("is never exhausted without a limit", () => {
    const budget = new CostBudget(undefined);
    budget.record(1000);
    expect(budget.isExhausted()).toBe(false);
  });

  it("becomes exhausted once spend reaches the limit", () => {
    const budget = new CostBudget(0.5);
    expect(budget.isExhausted()).toBe(false);
    budget.record(0.3);
    expect(budget.isExhausted()).toBe(false);
    budget.record(0.2);
    expect(budget.isExhausted()).toBe(true);
  });

  it("ignores non-positive records", () => {
    const budget = new CostBudget(1);
    budget.record(-5);
    budget.record(0);
    expect(budget.spent).toBe(0);
    expect(budget.isExhausted()).toBe(false);
  });

  it("is exhausted at a zero limit before any spend", () => {
    expect(new CostBudget(0).isExhausted()).toBe(true);
  });

  it("exposes spent and limit", () => {
    const budget = new CostBudget(2);
    budget.record(0.75);
    expect(budget.spent).toBe(0.75);
    expect(budget.limit).toBe(2);
  });
});
