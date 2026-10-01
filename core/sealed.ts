// Sealing a small message to somebody's key, so that whatever holds it on the
// way cannot read it.
//
// This exists for the post box: a service somewhere else takes a delivery that
// could not come straight to this box (WhatsApp's, which is pushed and never
// fetched) and keeps it until this runtime asks for it. It holds the message for
// seconds, and it holds it sealed, so a copy of its database is noise.
//
// X25519 for the key agreement and AES-256-GCM for the words, both from
// node:crypto, so there is nothing to install and nothing to go stale. The
// sealing half is written again wherever the post box runs, which is the one
// place in any of this that is written twice: `VECTOR` in ops/test.ts is a fixed
// input and its exact output, and the post box checks the same one, so the two
// cannot drift apart without a test saying so.
//
// The shape on the wire, every value base64url:
//
//   { ephemeral, iv, data }
//
//   ephemeral  the sender's one-off public key, SPKI
//   iv         twelve bytes
//   data       the words, encrypted, with the tag on the end
//
// The key both sides work out is HKDF-SHA256 over the shared secret, salted
// with the ephemeral public key and labelled "chloe sealed", so one stolen
// ciphertext tells nothing about the next.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";

const LABEL = "chloe sealed";
const TAG = 16;

/** A sealed message, as it travels: three values, each base64url. */
export interface Sealed {
  ephemeral: string;
  iv: string;
  data: string;
}

/** A pair of keys as text, to keep in a file: the public half is handed out, the private half is not. */
export interface Keys {
  publicKey: string;
  privateKey: string;
}

/** A new pair. The public half is what a post box is given, the private half never leaves this box. */
export function newKeys(): Keys {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

function publicFrom(key: string): KeyObject {
  return createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" });
}

function privateFrom(key: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(key, "base64url"), format: "der", type: "pkcs8" });
}

function keyFor(secret: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, Buffer.from(LABEL), 32));
}

/**
 * Seals text to a public key. `ephemeral` is only for the test vector: left
 * out, a new pair is made for every message, which is what makes two sealings
 * of the same words look nothing alike.
 */
export function seal(to: string, text: string, ephemeral?: Keys): Sealed {
  const mine = ephemeral ?? newKeys();
  const secret = diffieHellman({ privateKey: privateFrom(mine.privateKey), publicKey: publicFrom(to) });
  const salt = Buffer.from(mine.publicKey, "base64url");
  const iv = ephemeral ? Buffer.alloc(12) : randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret, salt), iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { ephemeral: mine.publicKey, iv: iv.toString("base64url"), data: data.toString("base64url") };
}

/** Opens a sealed message with the private half. Throws if it was changed on the way. */
export function unseal(privateKey: string, sealed: Sealed): string {
  const secret = diffieHellman({ privateKey: privateFrom(privateKey), publicKey: publicFrom(sealed.ephemeral) });
  const salt = Buffer.from(sealed.ephemeral, "base64url");
  const whole = Buffer.from(sealed.data, "base64url");
  if (whole.length <= TAG) throw new Error("That sealed message is too short to hold anything.");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret, salt), Buffer.from(sealed.iv, "base64url"));
  decipher.setAuthTag(whole.subarray(whole.length - TAG));
  return decipher.update(whole.subarray(0, whole.length - TAG)).toString("utf8") + decipher.final("utf8");
}
