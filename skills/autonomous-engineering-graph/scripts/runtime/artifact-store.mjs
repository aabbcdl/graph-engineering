import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function encode(value) {
  if (typeof value === "string") return value;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function writeArtifact(runDir, {
  kind = "artifact",
  value,
  metadata = {},
  extension = "json",
} = {}) {
  const content = encode(value);
  const sha256 = digest(content);
  const root = path.join(runDir, "artifacts");
  await mkdir(root, { recursive: true });
  const artifactPath = path.join(root, `${sha256}.${extension}`);
  try {
    await stat(artifactPath);
  } catch {
    const temporary = `${artifactPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, artifactPath);
  }
  const descriptor = {
    schema_version: 1,
    artifact_id: sha256,
    kind,
    sha256,
    bytes: Buffer.byteLength(content),
    path: path.relative(runDir, artifactPath).split(path.sep).join("/"),
    metadata,
    created_at: new Date().toISOString(),
  };
  const descriptorPath = path.join(root, `${sha256}.meta.json`);
  try {
    await stat(descriptorPath);
  } catch {
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return descriptor;
}

export async function readArtifact(runDir, descriptor) {
  if (!descriptor?.path) throw new TypeError("artifact descriptor with path is required");
  const target = path.resolve(runDir, descriptor.path);
  const root = path.resolve(runDir, "artifacts");
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Artifact path escapes the run directory");
  const content = await readFile(target, "utf8");
  const actual = digest(content);
  if (descriptor.sha256 && descriptor.sha256 !== actual) throw new Error("Artifact hash mismatch");
  return content;
}

