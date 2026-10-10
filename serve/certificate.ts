// The certificate `npx chloe --remote` serves the page with, made here with
// node's own crypto: nothing beside node can be assumed installed, and nobody
// signs a certificate for a bare address. A browser warns about it once.
//
// Kept in the state folder, mode 600, so a browser told to accept it is not
// asked again after a restart. It lasts a year and is made again a day before
// it runs out.
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { STATE } from "#chloe/core/paths";

export interface Certificate {
  key: string;
  cert: string;
  /** SHA-256 of the certificate, as a browser shows it, so a person can check theirs is this one. */
  fingerprint: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** This copy's certificate and its key, made the first time and whenever it is about to run out. */
export function certificate(): Certificate {
  const file = `${STATE}/remote.pem`;
  try {
    const pem = readFileSync(file, "utf8");
    const key = pem.match(/-----BEGIN PRIVATE KEY-----[^]+?-----END PRIVATE KEY-----\n/)?.[0];
    const cert = pem.match(/-----BEGIN CERTIFICATE-----[^]+?-----END CERTIFICATE-----\n/)?.[0];
    if (key && cert) {
      const read = new X509Certificate(cert);
      if (Date.parse(read.validTo) - Date.now() > DAY) return { key, cert, fingerprint: read.fingerprint256 };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const made = selfSigned();
  mkdirSync(STATE, { recursive: true });
  writeFileSync(file, made.key + made.cert, { mode: 0o600 });
  return made;
}

/** A self-signed certificate for "chloe", on a new P-256 key, good for a year from now. */
export function selfSigned(): Certificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = new Date();
  const algorithm = seq(oid("1.2.840.10045.4.3.2")); // ECDSA with SHA-256
  const name = seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from("chloe")))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40; // positive and of full length, as DER wants
  const signed = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, serial),
    algorithm,
    name,
    seq(time(now), time(new Date(now.getTime() + 365 * DAY))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", signed, privateKey);
  const body = seq(signed, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const cert = `-----BEGIN CERTIFICATE-----\n${body.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}

/** One DER value: its tag, its length, and what it holds. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

function seq(...parts: Buffer[]): Buffer {
  return der(0x30, ...parts);
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let left = n >> 7; left; left >>= 7) groups.unshift((left & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}

/** UTCTime, YYMMDDHHMMSSZ, which is what a certificate dated before 2050 must use. */
function time(at: Date): Buffer {
  return der(0x17, Buffer.from(`${at.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
}
