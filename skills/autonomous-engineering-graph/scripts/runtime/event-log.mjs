import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const EVENT_INDEX_STRIDE = 256;
const EVENT_LOCK_TIMEOUT_MS = 60_000;
const EVENT_LOCK_WAIT_MS = 20;

const appendQueues = new Map();

function queueFor(key, task) {
  const previous = appendQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  appendQueues.set(key, current);
  return current.finally(() => {
    if (appendQueues.get(key) === current) appendQueues.delete(key);
  });
}

function eventsPath(runDir) {
  return path.join(runDir, "events", "events.jsonl");
}

function headPath(runDir) {
  return path.join(runDir, "events", "events.head.json");
}

function indexPath(runDir) {
  return path.join(runDir, "events", "events.index.jsonl");
}

function lockPath(runDir) {
  return path.join(runDir, "events", "events.lock");
}

function eventHead(sequence = 0, byteOffset = 0, eventCount = 0, endsWithNewline = true) {
  return {
    schema_version: 1,
    sequence,
    byte_offset: byteOffset,
    event_count: eventCount,
    index_stride: EVENT_INDEX_STRIDE,
    ends_with_newline: endsWithNewline,
    updated_at: new Date().toISOString(),
  };
}

function validHead(value, size) {
  return Boolean(
    value &&
    value.schema_version === 1 &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0 &&
    Number.isSafeInteger(value.byte_offset) && value.byte_offset >= 0 && value.byte_offset <= size &&
    Number.isSafeInteger(value.event_count) && value.event_count >= 0 &&
    typeof value.ends_with_newline === "boolean" &&
    value.index_stride === EVENT_INDEX_STRIDE,
  );
}

async function atomicWriteText(target, text) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function acquireEventLock(runDir) {
  const target = lockPath(runDir);
  await mkdir(path.dirname(target), { recursive: true });
  const deadline = Date.now() + EVENT_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return async () => {
        await handle.close().catch(() => {});
        await rm(target, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const details = await stat(target).catch(() => null);
      if (details && Date.now() - details.mtimeMs > EVENT_LOCK_TIMEOUT_MS) {
        await rm(target, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring event log lock: ${target}`);
      await new Promise((resolve) => setTimeout(resolve, EVENT_LOCK_WAIT_MS));
    }
  }
}

function parseLineRecords(text) {
  const records = [];
  const indexes = [];
  let byteOffset = 0;
  let eventCount = 0;
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineBytes = Buffer.byteLength(rawLine, "utf8") + 1;
    if (line.trim()) {
      try {
        const event = JSON.parse(line);
        if (Number.isSafeInteger(event.sequence) && event.sequence > 0) {
          records.push(event);
          eventCount += 1;
          if (event.sequence === 1 || event.sequence % EVENT_INDEX_STRIDE === 0) {
            indexes.push({ sequence: event.sequence, byte_offset: byteOffset });
          }
        }
      } catch {
        // Ignore a partial or corrupted tail. The next append adds a separator.
      }
    }
    byteOffset += lineBytes;
  }
  return {
    records,
    indexes,
    head: eventHead(
      records.reduce((highest, event) => Math.max(highest, event.sequence), 0),
      Buffer.byteLength(String(text || ""), "utf8"),
      eventCount,
      String(text || "").length === 0 || String(text || "").endsWith("\n"),
    ),
  };
}

async function rebuildMetadataLocked(runDir) {
  const target = eventsPath(runDir);
  const text = await readFile(target, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const parsed = parseLineRecords(text);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicWriteText(headPath(runDir), `${JSON.stringify(parsed.head, null, 2)}\n`);
  const indexText = parsed.indexes.map((entry) => JSON.stringify(entry)).join("\n");
  await atomicWriteText(indexPath(runDir), indexText ? `${indexText}\n` : "");
  return { head: parsed.head, indexes: parsed.indexes };
}

async function readHead(runDir) {
  return JSON.parse(await readFile(headPath(runDir), "utf8"));
}

async function readIndexes(runDir) {
  const text = await readFile(indexPath(runDir), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return Number.isSafeInteger(value.sequence) && Number.isSafeInteger(value.byte_offset)
          ? [{ sequence: value.sequence, byte_offset: value.byte_offset }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.sequence - right.sequence);
}

async function metadataIsCurrent(runDir) {
  const targetDetails = await stat(eventsPath(runDir)).catch(() => null);
  if (!targetDetails) return false;
  const head = await readHead(runDir).catch(() => null);
  if (!validHead(head, targetDetails.size)) return false;
  const indexes = await readIndexes(runDir).catch(() => null);
  return Array.isArray(indexes) && (head.event_count === 0 || indexes.length > 0);
}

async function ensureMetadataLocked(runDir) {
  if (await metadataIsCurrent(runDir)) {
    return { head: await readHead(runDir), indexes: await readIndexes(runDir) };
  }
  return rebuildMetadataLocked(runDir);
}

async function ensureMetadata(runDir) {
  if (await metadataIsCurrent(runDir)) {
    return { head: await readHead(runDir), indexes: await readIndexes(runDir) };
  }
  const release = await acquireEventLock(runDir);
  try {
    return await ensureMetadataLocked(runDir);
  } finally {
    await release();
  }
}

async function appendEventLocked(runDir, event) {
  const target = eventsPath(runDir);
  let metadata = await ensureMetadataLocked(runDir);
  const details = await stat(target).catch(() => ({ size: 0 }));
  if (details.size !== metadata.head.byte_offset) {
    metadata = await rebuildMetadataLocked(runDir);
  }
  const sequence = metadata.head.sequence + 1;
  const record = {
    schema_version: 1,
    sequence,
    event_id: randomUUID(),
    type: String(event.type),
    run_id: event.run_id || null,
    work_item_id: event.work_item_id || null,
    attempt_id: event.attempt_id || null,
    occurred_at: event.occurred_at || new Date().toISOString(),
    source: event.source || "controller",
    payload: event.payload && typeof event.payload === "object" ? event.payload : { value: event.payload },
  };
  const separator = metadata.head.byte_offset > 0 && !metadata.head.ends_with_newline ? "\n" : "";
  const encoded = `${separator}${JSON.stringify(record)}\n`;
  await appendFile(target, encoded, "utf8");
  const byteOffset = metadata.head.byte_offset + Buffer.byteLength(encoded, "utf8");
  if (sequence === 1 || sequence % EVENT_INDEX_STRIDE === 0) {
    await appendFile(indexPath(runDir), `${JSON.stringify({ sequence, byte_offset: metadata.head.byte_offset + Buffer.byteLength(separator, "utf8") })}\n`, "utf8");
  }
  const nextHead = eventHead(sequence, byteOffset, metadata.head.event_count + 1);
  await atomicWriteText(headPath(runDir), `${JSON.stringify(nextHead, null, 2)}\n`);
  return record;
}

export async function appendRunEvent(runDir, {
  type,
  run_id: runId,
  work_item_id: workItemId = null,
  attempt_id: attemptId = null,
  payload = {},
  source = "controller",
  occurred_at: occurredAt = new Date().toISOString(),
} = {}) {
  if (!runDir) throw new TypeError("runDir is required");
  if (!type) throw new TypeError("event type is required");
  const target = eventsPath(runDir);
  return queueFor(target, async () => {
    const release = await acquireEventLock(runDir);
    try {
      return await appendEventLocked(runDir, {
        type,
        run_id: runId,
        work_item_id: workItemId,
        attempt_id: attemptId,
        payload,
        source,
        occurred_at: occurredAt,
      });
    } finally {
      await release();
    }
  });
}

async function streamEvents(target, offset, { since, types }) {
  const allowed = types ? new Set(types.map(String)) : null;
  const stream = createReadStream(target, { start: Math.max(0, offset) });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const events = [];
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if ((event.sequence || 0) <= since) continue;
        if (allowed && !allowed.has(event.type)) continue;
        events.push(event);
      } catch {
        // Ignore a partial or corrupted event line.
      }
    }
  }
  pending += decoder.end();
  if (pending.trim()) {
    try {
      const event = JSON.parse(pending);
      if ((event.sequence || 0) > since && (!allowed || allowed.has(event.type))) events.push(event);
    } catch {
      // Ignore a partial tail.
    }
  }
  return events;
}

export async function readRunEvents(runDir, { since = 0, types = null } = {}) {
  const metadata = await ensureMetadata(runDir);
  if (metadata.head.sequence <= since) return [];
  const starting = metadata.indexes.reduce(
    (best, entry) => entry.sequence <= since && entry.sequence >= best.sequence ? entry : best,
    { sequence: 0, byte_offset: 0 },
  );
  return streamEvents(eventsPath(runDir), starting.byte_offset, { since, types });
}

export function eventLogPath(runDir) {
  return eventsPath(runDir);
}

export function eventLogMetadataPaths(runDir) {
  return {
    events: eventsPath(runDir),
    head: headPath(runDir),
    index: indexPath(runDir),
    lock: lockPath(runDir),
  };
}

export const __test = {
  EVENT_INDEX_STRIDE,
  parseLineRecords,
  metadataIsCurrent,
  rebuildMetadataLocked,
};
