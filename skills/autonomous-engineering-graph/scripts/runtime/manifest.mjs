import { createHash } from "node:crypto";
import { lstat, readFile, readlink, stat } from "node:fs/promises";

function normalizeMode(mode) {
  return Number.isInteger(mode) ? mode & 0o777 : null;
}

export function normalizeManifestRecord(record) {
  if (!record || record.missing) return { kind: null, missing: true, sha256: null, mode: null, link_target: null, link_type: null };
  return {
    kind: record.kind || null,
    missing: false,
    sha256: record.sha256 || null,
    mode: normalizeMode(record.mode),
    link_target: record.link_target || null,
    link_type: record.link_type || null,
  };
}

export function manifestRecordsEqual(left, right) {
  return JSON.stringify(normalizeManifestRecord(left)) === JSON.stringify(normalizeManifestRecord(right));
}

export function manifestFilesDiff(before = {}, after = {}) {
  const leftFiles = before.files || before;
  const rightFiles = after.files || after;
  const files = new Set([...Object.keys(leftFiles || {}), ...Object.keys(rightFiles || {})]);
  return [...files].sort().filter((relative) => !manifestRecordsEqual(leftFiles?.[relative], rightFiles?.[relative]));
}

export async function manifestRecordForPath(target) {
  try {
    const details = await lstat(target);
    if (details.isSymbolicLink()) {
      const linkTarget = await readlink(target);
      const linkType = process.platform === "win32"
        ? (await stat(target).catch(() => null))?.isDirectory() ? "junction" : "file"
        : null;
      return {
        kind: "symlink",
        link_target: linkTarget,
        link_type: linkType,
        sha256: createHash("sha256").update(`symlink\0${linkTarget}`).digest("hex"),
        size: Buffer.byteLength(linkTarget),
        mode: normalizeMode(details.mode),
      };
    }
    if (!details.isFile()) return null;
    return {
      kind: "file",
      sha256: createHash("sha256").update(await readFile(target)).digest("hex"),
      size: details.size,
      mode: normalizeMode(details.mode),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    throw error;
  }
}

export async function manifestPathMatches(target, record) {
  const actual = await manifestRecordForPath(target);
  return manifestRecordsEqual(actual, record);
}
