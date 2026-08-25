import { describe, expect, it } from "vite-plus/test";

import {
  createProjectSyncFrameDecoder,
  encodeProjectSyncRecords,
  type ProjectSyncFrameDecodedRecord,
  type ProjectSyncFrameRecord,
} from "./projectSyncFraming.ts";

async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function* asChunksOfSize(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

async function* asOne(records: ProjectSyncFrameRecord[]): AsyncIterable<ProjectSyncFrameRecord> {
  for (const record of records) yield record;
}

async function encodeToBytes(records: ProjectSyncFrameRecord[]): Promise<Uint8Array> {
  return collectBytes(encodeProjectSyncRecords(asOne(records)));
}

async function decodeAll(
  bytes: Uint8Array,
  chunkSize: number,
): Promise<Array<{ header: ProjectSyncFrameDecodedRecord["header"]; content: Uint8Array }>> {
  const decoded: Array<{ header: ProjectSyncFrameDecodedRecord["header"]; content: Uint8Array }> =
    [];
  for await (const record of createProjectSyncFrameDecoder(asChunksOfSize(bytes, chunkSize))) {
    const content = await collectBytes(record.content);
    decoded.push({ header: record.header, content });
  }
  return decoded;
}

describe("projectSyncFraming", () => {
  it("round-trips multiple files through a single-byte-chunked stream", async () => {
    const fileA = new TextEncoder().encode("hello world");
    const fileB = new TextEncoder().encode("a".repeat(300));

    const records: ProjectSyncFrameRecord[] = [
      {
        header: { path: "src/a.txt", size: fileA.length, kind: "file", mode: 0o644 },
        content: fileA,
      },
      {
        header: { path: "src/nested/b.txt", size: fileB.length, kind: "file" },
        content: fileB,
      },
    ];

    const encoded = await encodeToBytes(records);
    const decoded = await decodeAll(encoded, 1);

    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.header).toEqual({
      path: "src/a.txt",
      size: fileA.length,
      kind: "file",
      mode: 0o644,
    });
    expect(new TextDecoder().decode(decoded[0]!.content)).toBe("hello world");
    expect(decoded[1]!.header.path).toBe("src/nested/b.txt");
    expect(decoded[1]!.content).toEqual(fileB);
  });

  it("round-trips an empty file", async () => {
    const records: ProjectSyncFrameRecord[] = [
      { header: { path: "empty.txt", size: 0, kind: "file" }, content: new Uint8Array(0) },
    ];

    const encoded = await encodeToBytes(records);
    const decoded = await decodeAll(encoded, 7);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.header.size).toBe(0);
    expect(decoded[0]!.content.length).toBe(0);
  });

  it("round-trips dir and symlink entries with no content", async () => {
    const records: ProjectSyncFrameRecord[] = [
      { header: { path: "src/empty-dir", size: 0, kind: "dir" }, content: new Uint8Array(0) },
      {
        header: {
          path: "src/link",
          size: 0,
          kind: "symlink",
          linkTarget: "../target.txt",
        },
        content: new Uint8Array(0),
      },
    ];

    const encoded = await encodeToBytes(records);
    const decoded = await decodeAll(encoded, 3);

    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.header.kind).toBe("dir");
    expect(decoded[1]!.header.kind).toBe("symlink");
    expect(decoded[1]!.header.linkTarget).toBe("../target.txt");
  });

  it("round-trips a record with a large header", async () => {
    const longPath = `src/${"segment/".repeat(400)}file.txt`;
    const content = new TextEncoder().encode("payload after a large header");

    const records: ProjectSyncFrameRecord[] = [
      { header: { path: longPath, size: content.length, kind: "file" }, content },
    ];

    const encoded = await encodeToBytes(records);
    // Chunk right around the header-length boundary in a few different ways.
    for (const chunkSize of [1, 5, 64, 4096]) {
      const decoded = await decodeAll(encoded, chunkSize);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.header.path).toBe(longPath);
      expect(new TextDecoder().decode(decoded[0]!.content)).toBe("payload after a large header");
    }
  });

  it("accepts async-iterable content and streams it back out", async () => {
    const total = new TextEncoder().encode("streamed-content-body");
    async function* chunked(): AsyncIterable<Uint8Array> {
      yield total.subarray(0, 5);
      yield total.subarray(5, 12);
      yield total.subarray(12);
    }

    const records: ProjectSyncFrameRecord[] = [
      { header: { path: "stream.bin", size: total.length, kind: "file" }, content: chunked() },
    ];

    const encoded = await encodeToBytes(records);
    const decoded = await decodeAll(encoded, 4);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.content).toEqual(total);
  });

  it("drains an unread record so the next header still parses correctly", async () => {
    const fileA = new TextEncoder().encode("first-file-content");
    const fileB = new TextEncoder().encode("second-file-content");

    const records: ProjectSyncFrameRecord[] = [
      { header: { path: "a.txt", size: fileA.length, kind: "file" }, content: fileA },
      { header: { path: "b.txt", size: fileB.length, kind: "file" }, content: fileB },
    ];

    const encoded = await encodeToBytes(records);

    const paths: string[] = [];
    for await (const record of createProjectSyncFrameDecoder(asChunksOfSize(encoded, 6))) {
      // Deliberately never touch `record.content` for the first record.
      paths.push(record.header.path);
    }

    expect(paths).toEqual(["a.txt", "b.txt"]);
  });

  it("throws when the content stream ends before the declared size", async () => {
    const encoded = await encodeToBytes([
      { header: { path: "truncated.txt", size: 10, kind: "file" }, content: new Uint8Array(10) },
    ]);
    const truncated = encoded.subarray(0, encoded.length - 5);

    await expect(
      (async () => {
        for await (const record of createProjectSyncFrameDecoder(asChunksOfSize(truncated, 3))) {
          await collectBytes(record.content);
        }
      })(),
    ).rejects.toThrow(/mid-content/);
  });

  it("throws when a record's declared size does not match the actual content length", async () => {
    await expect(
      encodeToBytes([
        { header: { path: "mismatch.txt", size: 5, kind: "file" }, content: new Uint8Array(3) },
      ]),
    ).rejects.toThrow(/length mismatch/);
  });

  it("rejects an absurd header length instead of buffering the whole stream", async () => {
    // A hostile body can claim a 4 GiB header; without a ceiling the decoder
    // would pull every byte the peer cares to send while waiting for it.
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 0xffffffff, false);

    let pulledChunks = 0;
    async function* endlessBody(): AsyncIterable<Uint8Array> {
      yield header;
      while (true) {
        pulledChunks += 1;
        yield new Uint8Array(1024);
      }
    }

    await expect(
      (async () => {
        for await (const _record of createProjectSyncFrameDecoder(endlessBody())) {
          // Never reached: the header length is refused before any pulling.
        }
      })(),
    ).rejects.toThrow(/exceeds the .* byte limit/);
    expect(pulledChunks).toBe(0);
  });

  describe("hostile headers", () => {
    /** Hand-rolls one frame so a header the encoder would never produce can be
        fed to the decoder. */
    function rawFrame(headerJson: string, content = new Uint8Array(0)): Uint8Array {
      const headerBytes = new TextEncoder().encode(headerJson);
      const out = new Uint8Array(4 + headerBytes.length + content.length);
      new DataView(out.buffer).setUint32(0, headerBytes.length, false);
      out.set(headerBytes, 4);
      out.set(content, 4 + headerBytes.length);
      return out;
    }

    /** Decodes, returning how many records made it out before the throw. */
    async function decodeCountingRecords(bytes: Uint8Array): Promise<number> {
      let yielded = 0;
      for await (const record of createProjectSyncFrameDecoder(asChunksOfSize(bytes, 5))) {
        yielded += 1;
        await collectBytes(record.content);
      }
      return yielded;
    }

    const cases: Array<[string, string, RegExp]> = [
      [
        // A negative size *credits* the import route's byte budget, so a token
        // signed for a kilobyte could authorize an unbounded write.
        "negative size",
        JSON.stringify({ path: "a.txt", size: -10_000_000_000, kind: "file" }),
        /invalid size/,
      ],
      ["string size", JSON.stringify({ path: "a.txt", size: "10", kind: "file" }), /invalid size/],
      [
        "fractional size",
        JSON.stringify({ path: "a.txt", size: 1.5, kind: "file" }),
        /invalid size/,
      ],
      ["unknown kind", JSON.stringify({ path: "a.txt", size: 0, kind: "device" }), /unknown kind/],
      ["missing kind", JSON.stringify({ path: "a.txt", size: 0 }), /unknown kind/],
      ["empty path", JSON.stringify({ path: "", size: 0, kind: "file" }), /non-empty 'path'/],
      ["non-string path", JSON.stringify({ path: 42, size: 0, kind: "file" }), /non-empty 'path'/],
      [
        "negative mode",
        JSON.stringify({ path: "a.txt", size: 0, kind: "file", mode: -1 }),
        /invalid mode/,
      ],
      [
        "non-string link target",
        JSON.stringify({ path: "a", size: 0, kind: "symlink", linkTarget: 7 }),
        /non-string link target/,
      ],
      ["array header", "[1,2,3]", /not a JSON object/],
      ["invalid JSON", "{not json", /not valid JSON/],
    ];

    for (const [name, headerJson, expected] of cases) {
      it(`rejects a header with a ${name} before yielding anything`, async () => {
        let yielded = -1;
        await expect(
          (async () => {
            yielded = await decodeCountingRecords(rawFrame(headerJson));
          })(),
        ).rejects.toThrow(expected);
        expect(yielded).toBe(-1);
      });
    }

    it("rejects the hostile header even when a valid record precedes it", async () => {
      const valid = await encodeToBytes([
        { header: { path: "ok.txt", size: 2, kind: "file" }, content: new Uint8Array([1, 2]) },
      ]);
      const hostile = rawFrame(JSON.stringify({ path: "b.txt", size: -1, kind: "file" }));
      const combined = new Uint8Array(valid.length + hostile.length);
      combined.set(valid, 0);
      combined.set(hostile, valid.length);

      let yielded = 0;
      await expect(
        (async () => {
          for await (const record of createProjectSyncFrameDecoder(asChunksOfSize(combined, 4))) {
            yielded += 1;
            await collectBytes(record.content);
          }
        })(),
      ).rejects.toThrow(/invalid size/);
      expect(yielded).toBe(1);
    });
  });

  it("reads only the declared size when a header under-reports its content", async () => {
    // A header that lies low turns the trailing bytes into the next record's
    // header, which must fail loudly rather than be silently applied.
    const content = new TextEncoder().encode("0123456789");
    const encoded = await encodeToBytes([
      { header: { path: "liar.txt", size: 4, kind: "file" }, content: content.subarray(0, 4) },
    ]);
    const withTrailingGarbage = new Uint8Array(encoded.length + content.length);
    withTrailingGarbage.set(encoded, 0);
    withTrailingGarbage.set(content, encoded.length);

    await expect(
      (async () => {
        for await (const record of createProjectSyncFrameDecoder(
          asChunksOfSize(withTrailingGarbage, 3),
        )) {
          await collectBytes(record.content);
        }
      })(),
    ).rejects.toThrow();
  });
});
