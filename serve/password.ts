// Passwords as they are kept, for the owner's account and for the people the
// owner invites. Hand rolled on node:crypto's scrypt, because the alternative
// is a dependency for twenty lines.
import crypto from "node:crypto";

/**
 * scrypt:N:r:p:salt:hash, colon separated rather than the usual $ separated
 * form: some environment loaders read $16384 as a variable and quietly cut the
 * hash in half, which is a login that always fails and never says why.
 */
export function hashPassword(password: string): string {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const made = crypto.scryptSync(password.normalize("NFKC"), salt, 32, { N, r, p });
  return `scrypt:${N}:${r}:${p}:${salt.toString("base64")}:${made.toString("base64")}`;
}

/** Whether `password` is the one `stored` was made from. */
export function checkPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, salt, expected] = stored.split(":");
    if (scheme !== "scrypt") return false;
    const want = Buffer.from(expected, "base64");
    const got = crypto.scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64"), want.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Compares without letting the time it takes say how much of it matched. */
export function same(a: string, b: string): boolean {
  const one = Buffer.from(a), two = Buffer.from(b);
  if (one.length !== two.length) return false;
  return crypto.timingSafeEqual(one, two);
}
