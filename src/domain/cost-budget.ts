class CostBudget {
  private spentUsd = 0;

  constructor(private readonly limitUsd: number | undefined) {}

  isExhausted(): boolean {
    return this.limitUsd !== undefined && this.spentUsd >= this.limitUsd;
  }

  record(usd: number): void {
    if (usd > 0) {
      this.spentUsd += usd;
    }
  }

  get spent(): number {
    return this.spentUsd;
  }

  get limit(): number | undefined {
    return this.limitUsd;
  }
}

export { CostBudget };
