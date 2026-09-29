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

export { RepositoryTooLargeError };
