import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger, serializeComposerFileLink } from "./composerTrigger.ts";

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("detectComposerTrigger profile shortcuts", () => {
  it("detects a #profile token at the start of the message", () => {
    const text = "#reviewer look at this";
    expect(detectComposerTrigger(text, "#reviewer".length)).toEqual({
      kind: "profile",
      query: "reviewer",
      rangeStart: 0,
      rangeEnd: 9,
    });
  });

  it("opens on a bare # at message start", () => {
    expect(detectComposerTrigger("#", 1)).toEqual({
      kind: "profile",
      query: "",
      rangeStart: 0,
      rangeEnd: 1,
    });
  });

  it("ignores issue references and mid-text hashtags", () => {
    const issue = "Fix #123";
    expect(detectComposerTrigger(issue, issue.length)).toBeNull();
    expect(detectComposerTrigger("#123", 4)).toBeNull();
    const midText = "The issue #reviewer is unrelated";
    expect(detectComposerTrigger(midText, midText.length)).toBeNull();
  });

  it("stops triggering once the token ends", () => {
    const text = "#reviewer done";
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });
});
