class RepositoryTooLargeError extends Error {
  override readonly name = "RepositoryTooLargeError";

  constructor(
    readonly reviewableFiles: number,
    readonly maxReviewableFiles: number,
  ) {
    super(
      `Repository has ${String(reviewableFiles)} reviewable files; the limit is ${String(maxReviewableFiles)}`,
    );
  }
}

function assertReviewableFileLimit(maxReviewableFiles: number): void {
  if (!Number.isInteger(maxReviewableFiles) || maxReviewableFiles < 1) {
    throw new Error(
      `maxReviewableFiles must be a positive integer, got ${String(maxReviewableFiles)}`,
    );
  }
}

export { assertReviewableFileLimit, RepositoryTooLargeError };
