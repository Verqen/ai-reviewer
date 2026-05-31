class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  tryAcquire(tokens: number = 1): boolean {
    this.refill();

    if (this.tokens < tokens) {
      return false;
    }

    this.tokens -= tokens;
    return true;
  }

  async acquire(tokens: number = 1): Promise<void> {
    while (!this.tryAcquire(tokens)) {
      const tokensNeeded = tokens - this.tokens;
      const waitMs = Math.ceil((tokensNeeded / this.refillRate) * 1000);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillAt) / 1000;
    const added = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillAt = now;
  }
}

export { TokenBucket };
