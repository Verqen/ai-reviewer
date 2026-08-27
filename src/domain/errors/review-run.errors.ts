class ReviewRunConflictError extends Error {
  constructor(message = "A review run with this identity already exists") {
    super(message);
    this.name = "ReviewRunConflictError";
  }
}

export { ReviewRunConflictError };
