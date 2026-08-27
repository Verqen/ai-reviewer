import { createHash, timingSafeEqual } from "node:crypto";

function hashValue(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secretsMatch(candidate: string | undefined, secret: string): boolean {
  if (candidate === undefined) {
    return false;
  }
  return timingSafeEqual(hashValue(candidate), hashValue(secret));
}

function bearerToken(
  header: string | string[] | undefined,
): string | undefined {
  if (typeof header !== "string") {
    return undefined;
  }
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || value === undefined) {
    return undefined;
  }
  return value;
}

export { bearerToken, hashValue, secretsMatch };
