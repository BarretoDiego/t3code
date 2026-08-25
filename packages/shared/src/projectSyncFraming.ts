/**
 * Binary framing for project sync file transfers.
 *
 * Both ends of a project sync transfer are our own code (the sync client
 * streaming a request body, our HTTP handler streaming a response body), so
 * this is a purpose-built framing format rather than a general interchange
 * format. Each record on the wire is:
 *
 *   [ uint32 BE header length ][ UTF-8 JSON header ][ raw content bytes ]
 *
 * `content` is exactly `header.size` bytes, unencoded. Directories and
 * symlinks carry `size: 0` and therefore no content bytes at all. A stream is
 * simply a concatenation of records with no trailing marker; the reader
 * knows it has reached the end when the underlying byte source is exhausted
 * cleanly on a record boundary.
 *
 * @module projectSyncFraming
 */
import type { ProjectSyncEntryKind } from "@t3tools/contracts";

const HEADER_LENGTH_BYTES = 4;

/**
 * Ceiling on a single record's JSON header.
 *
 * The length prefix is a uint32, so a hostile (or corrupt) stream can claim a
 * 4 GiB header and make the decoder buffer the whole request body waiting for
 * it. Real headers are a path (capped at 1024 characters by the contract)
 * plus a handful of small fields, so anything past 64 KiB is not a header we
 * would ever have written.
 */
const MAX_HEADER_BYTES = 64 * 1024;

const FRAME_ENTRY_KINDS: ReadonlySet<string> = new Set(["file", "dir", "symlink"]);

export interface ProjectSyncFrameHeader {
  readonly path: string;
  readonly size: number;
  readonly kind: ProjectSyncEntryKind;
  readonly mode?: number;
  readonly linkTarget?: string;
}

/**
 * Parses and validates one JSON header off the wire.
 *
 * Nothing downstream re-checks these fields: the import route adds
 * `header.size` to the byte budget the signed URL authorized, and the apply
 * pass switches on `header.kind`. A header claiming `size: -1e10` would
 * therefore *credit* the budget and let a token signed for a kilobyte write
 * without bound, and a non-numeric size would turn the content cursor into
 * NaN. So the decoder refuses anything it would not itself have written.
 */
function parseFrameHeader(json: string): ProjectSyncFrameHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error("Project sync frame header is not valid JSON.", { cause });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Project sync frame header is not a JSON object.");
  }

  const header = parsed as Record<string, unknown>;
  const { path, size, kind, mode, linkTarget } = header;

  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Project sync frame header is missing a non-empty 'path'.");
  }
  if (!FRAME_ENTRY_KINDS.has(kind as string)) {
    throw new Error(
      `Project sync frame header for '${path}' has an unknown kind ${JSON.stringify(kind)}.`,
    );
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(
      `Project sync frame header for '${path}' has an invalid size ${JSON.stringify(size)}.`,
    );
  }
  if (mode !== undefined && (typeof mode !== "number" || !Number.isSafeInteger(mode) || mode < 0)) {
    throw new Error(
      `Project sync frame header for '${path}' has an invalid mode ${JSON.stringify(mode)}.`,
    );
  }
  if (linkTarget !== undefined && typeof linkTarget !== "string") {
    throw new Error(`Project sync frame header for '${path}' has a non-string link target.`);
  }

  return {
    path,
    size,
    kind: kind as ProjectSyncEntryKind,
    ...(mode === undefined ? {} : { mode }),
    ...(linkTarget === undefined ? {} : { linkTarget }),
  };
}

/** One record to encode: a header plus its content, given either as a single
    buffer or as a stream of chunks summing to exactly `header.size` bytes. */
export interface ProjectSyncFrameRecord {
  readonly header: ProjectSyncFrameHeader;
  readonly content: AsyncIterable<Uint8Array> | Uint8Array;
}

/** One record as decoded off the wire. `content` must be iterated to
    completion (or left untouched) before requesting the next record from the
    same decoder — the decoder shares a single cursor across records and
    drains any unread bytes automatically once the caller moves on. */
export interface ProjectSyncFrameDecodedRecord {
  readonly header: ProjectSyncFrameHeader;
  readonly content: AsyncIterable<Uint8Array>;
}

function encodeHeaderLength(length: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_LENGTH_BYTES);
  new DataView(bytes.buffer).setUint32(0, length, false);
  return bytes;
}

function isAsyncIterableContent(
  value: ProjectSyncFrameRecord["content"],
): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/**
 * Encodes an async iterable of records into the wire framing described above.
 *
 * Throws if a record's actual content length does not match its declared
 * `header.size` — a mismatch means the caller computed the manifest entry
 * wrong, and the alternative (silently sending a corrupt frame) is worse.
 */
export async function* encodeProjectSyncRecords(
  records: AsyncIterable<ProjectSyncFrameRecord>,
): AsyncGenerator<Uint8Array> {
  const textEncoder = new TextEncoder();

  for await (const record of records) {
    const headerJson = textEncoder.encode(JSON.stringify(record.header));
    yield encodeHeaderLength(headerJson.length);
    if (headerJson.length > 0) yield headerJson;

    if (isAsyncIterableContent(record.content)) {
      let written = 0;
      for await (const chunk of record.content) {
        if (chunk.length === 0) continue;
        written += chunk.length;
        yield chunk;
      }
      if (written !== record.header.size) {
        throw new Error(
          `Project sync frame content length mismatch for '${record.header.path}': ` +
            `declared ${record.header.size} bytes, wrote ${written}.`,
        );
      }
    } else {
      if (record.content.length !== record.header.size) {
        throw new Error(
          `Project sync frame content length mismatch for '${record.header.path}': ` +
            `declared ${record.header.size} bytes, wrote ${record.content.length}.`,
        );
      }
      if (record.content.length > 0) yield record.content;
    }
  }
}

/**
 * Incrementally buffers chunks pulled from an underlying async iterator so
 * callers can ask for "at least N bytes" without caring how the upstream
 * source happened to chunk the data (one byte at a time, one giant buffer,
 * anything in between).
 *
 * Kept as a small chunk queue with an amortized-O(1) `take`/`takeUpTo`
 * instead of repeatedly concatenating into one growing buffer, since project
 * sync payloads can be large and framing is on the hot path of every sync.
 */
class ChunkCursor {
  private readonly source: AsyncIterator<Uint8Array>;
  private readonly pending: Uint8Array[] = [];
  private pendingLength = 0;
  private sourceExhausted = false;

  constructor(source: AsyncIterator<Uint8Array>) {
    this.source = source;
  }

  private async pullOne(): Promise<boolean> {
    if (this.sourceExhausted) return false;
    const { value, done } = await this.source.next();
    if (done) {
      this.sourceExhausted = true;
      return false;
    }
    if (value.length > 0) {
      this.pending.push(value);
      this.pendingLength += value.length;
    }
    return true;
  }

  /** Pulls from the source until at least `n` bytes are buffered, or the
      source is exhausted. Returns whether `n` bytes are now available. */
  async ensure(n: number): Promise<boolean> {
    while (this.pendingLength < n) {
      if (!(await this.pullOne())) break;
    }
    return this.pendingLength >= n;
  }

  get bufferedLength(): number {
    return this.pendingLength;
  }

  /** Consumes exactly `n` buffered bytes. Callers must `ensure(n)` first. */
  take(n: number): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    const first = this.pending[0];
    if (first && first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.pending.shift();
      else this.pending[0] = first.subarray(n);
      this.pendingLength -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.pending[0];
      if (!chunk) throw new Error("ChunkCursor.take: fewer than n bytes were buffered.");
      const wanted = n - offset;
      if (chunk.length <= wanted) {
        out.set(chunk, offset);
        offset += chunk.length;
        this.pending.shift();
      } else {
        out.set(chunk.subarray(0, wanted), offset);
        this.pending[0] = chunk.subarray(wanted);
        offset += wanted;
      }
    }
    this.pendingLength -= n;
    return out;
  }

  /** Consumes up to `n` bytes without merging across chunk boundaries — the
      returned view is a subarray of a single already-buffered chunk. Used
      for streaming content out without forcing extra copies. */
  takeUpTo(n: number): Uint8Array {
    const first = this.pending[0];
    if (!first || n <= 0) return new Uint8Array(0);
    const want = Math.min(n, first.length);
    const out = first.subarray(0, want);
    if (first.length === want) this.pending.shift();
    else this.pending[0] = first.subarray(want);
    this.pendingLength -= want;
    return out;
  }
}

function createContentIterable(
  cursor: ChunkCursor,
  size: number,
  path: string,
  state: { consumed: number },
): AsyncIterable<Uint8Array> {
  const iterator: AsyncIterator<Uint8Array> = {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (state.consumed >= size) {
        return { done: true, value: undefined };
      }
      const remaining = size - state.consumed;
      const haveByte = await cursor.ensure(1);
      if (!haveByte) {
        throw new Error(
          `Project sync frame stream ended mid-content for '${path}' ` +
            `(${state.consumed}/${size} bytes read).`,
        );
      }
      const chunk = cursor.takeUpTo(remaining);
      state.consumed += chunk.length;
      return { done: false, value: chunk };
    },
    async return(value?: unknown): Promise<IteratorResult<Uint8Array>> {
      // `for await...of` calls `return()` when the consumer stops early
      // (e.g. `break`). The decoder shares one cursor across every record in
      // the stream, so an early stop must still drain this record's
      // remaining bytes — otherwise the next record would be parsed starting
      // from the middle of this one's leftover content.
      while (state.consumed < size) {
        const haveByte = await cursor.ensure(1);
        if (!haveByte) break;
        const chunk = cursor.takeUpTo(size - state.consumed);
        state.consumed += chunk.length;
      }
      return { done: true, value: value as Uint8Array | undefined };
    },
  };

  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

/**
 * Parses a stream of raw chunks (of any, possibly tiny, granularity) into
 * project sync frame records. Yields one `{ header, content }` pair per
 * record; `content` streams exactly `header.size` bytes.
 *
 * If the caller moves on to the next record (or stops iterating the decoder
 * entirely) before fully draining a record's `content`, the decoder drains
 * the remainder itself so the shared byte cursor stays aligned on the next
 * record's header.
 */
export async function* createProjectSyncFrameDecoder(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<ProjectSyncFrameDecodedRecord> {
  const cursor = new ChunkCursor(chunks[Symbol.asyncIterator]());
  const textDecoder = new TextDecoder();

  while (true) {
    const haveLength = await cursor.ensure(HEADER_LENGTH_BYTES);
    if (!haveLength) {
      if (cursor.bufferedLength > 0) {
        throw new Error("Project sync frame stream ended mid-header-length.");
      }
      return;
    }
    const lengthBytes = cursor.take(HEADER_LENGTH_BYTES);
    const headerLength = new DataView(
      lengthBytes.buffer,
      lengthBytes.byteOffset,
      lengthBytes.byteLength,
    ).getUint32(0, false);

    if (headerLength > MAX_HEADER_BYTES) {
      throw new Error(
        `Project sync frame header of ${headerLength} bytes exceeds the ${MAX_HEADER_BYTES} byte limit.`,
      );
    }

    const haveHeader = await cursor.ensure(headerLength);
    if (!haveHeader) {
      throw new Error("Project sync frame stream ended mid-header.");
    }
    const headerBytes = cursor.take(headerLength);
    const header = parseFrameHeader(textDecoder.decode(headerBytes));

    const state = { consumed: 0 };
    const content = createContentIterable(cursor, header.size, header.path, state);

    yield { header, content };

    // Defensive drain: covers the case where the caller never touched
    // `content` at all (so the iterator's `return()` was never invoked).
    while (state.consumed < header.size) {
      const haveByte = await cursor.ensure(1);
      if (!haveByte) {
        throw new Error(
          `Project sync frame stream ended mid-content for '${header.path}' ` +
            `(${state.consumed}/${header.size} bytes read).`,
        );
      }
      const chunk = cursor.takeUpTo(header.size - state.consumed);
      state.consumed += chunk.length;
    }
  }
}
