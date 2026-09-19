#!/usr/bin/env node
// Verify the vendored beacon-library tarball, its recorded SHA-256, the pinned
// library commit id, and package.json's dependency line still line up. Makes
// no network request: the tarball ships in vendor/, its SHA-256 in
// vendor/beacon-library-1.0.0.tgz.sha256, and the library commit id in
// BEACON_LIBRARY_SHA.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARBALL_REL = "vendor/beacon-library-1.0.0.tgz";
const SHA_FILE_REL = "vendor/beacon-library-1.0.0.tgz.sha256";
const COMMIT_FILE_REL = "BEACON_LIBRARY_SHA";
const DEP_NAME = "beacon-library";
const DEP_TARGET = "file:vendor/beacon-library-1.0.0.tgz";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function die(msg) {
  process.stderr.write(`check-beacon-library: ${msg}\n`);
  process.exit(1);
}

function readText(rel) {
  const p = join(repoRoot, rel);
  try {
    return readFileSync(p, "utf8");
  } catch {
    die(`missing ${rel}`);
  }
}

function readBytes(rel) {
  const p = join(repoRoot, rel);
  try {
    return readFileSync(p);
  } catch {
    die(`missing ${rel}`);
  }
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function main() {
  const tarball = readBytes(TARBALL_REL);
  const actualHash = sha256Hex(tarball);

  const shaFileRaw = readText(SHA_FILE_REL).trim();
  // The sidecar file follows the `<hash>  <name>` convention of shasum(1);
  // take the leading hex word.
  const recordedHash = shaFileRaw.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(recordedHash)) {
    die(`${SHA_FILE_REL} does not carry a 64-char SHA-256`);
  }
  if (recordedHash !== actualHash) {
    die(
      `SHA-256 mismatch: ${TARBALL_REL} hashes to ${actualHash}, ${SHA_FILE_REL} says ${recordedHash}`,
    );
  }

  const pkgRaw = readText("package.json");
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw);
  } catch (err) {
    die(`package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const deps = (pkg && pkg.dependencies) || {};
  const depValue = deps[DEP_NAME];
  if (depValue !== DEP_TARGET) {
    die(
      `package.json dependencies.${DEP_NAME} must be "${DEP_TARGET}"; found ${JSON.stringify(depValue)}`,
    );
  }

  const commitRaw = readText(COMMIT_FILE_REL).trim();
  if (!/^[0-9a-f]{40}$/i.test(commitRaw)) {
    die(`${COMMIT_FILE_REL} is not a 40-char hex commit id`);
  }

  process.stdout.write("check-beacon-library: ok\n");
}

main();
