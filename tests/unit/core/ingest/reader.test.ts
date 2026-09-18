/**
 * @file Unit tests for core/ingest/reader.ts (docs/development.md P4.2).
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CompleteLine,
  NODE_READER_FS,
  type ReaderFs,
  readCompleteLines,
  readStart,
} from "../../../../core/ingest/reader.js";

/**
 * Writes a temp file with the given contents.
 * @param contents - File bytes.
 * @returns The file path.
 */
function file(contents: string | Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), "aua-reader-")), "log.jsonl");
  writeFileSync(path, contents);
  return path;
}

/**
 * Reads complete lines and collects them as text with offsets and numbers.
 * @param path - File to read.
 * @param start - Resume point.
 * @param chunkSize - Bytes per read.
 * @returns The collected lines and the read result.
 */
function collect(
  path: string,
  start = { byteOffset: 0, lineCount: 0 },
  chunkSize?: number,
): { lines: [string, number, number][]; result: ReturnType<typeof readCompleteLines> } {
  const lines: [string, number, number][] = [];
  const result = readCompleteLines(
    path,
    start,
    (line: CompleteLine) => lines.push([line.bytes.toString("utf8"), line.offset, line.lineNumber]),
    chunkSize,
  );
  return { lines, result };
}

describe("readStart", () => {
  const state = { byteOffset: 100, lineCount: 4, size: 120, inode: 7 };

  it("starts a never-seen file at the beginning", () => {
    expect(readStart(null, { size: 50, inode: 7 })).toEqual({
      byteOffset: 0,
      lineCount: 0,
      rewritten: false,
    });
  });

  it.each([
    ["the file grew", { size: 200, inode: 7 }],
    ["nothing changed", { size: 120, inode: 7 }],
    ["the size equals the offset", { size: 100, inode: 7 }],
    ["the stored inode is unknown", { size: 150, inode: null }],
  ])("resumes at the stored offset when %s", (_name, stat) => {
    const start = readStart(stat.inode === null ? state : state, stat);
    expect(start).toEqual({ byteOffset: 100, lineCount: 4, rewritten: false });
  });

  it("ignores an inode comparison when the stored inode is null", () => {
    expect(readStart({ ...state, inode: null }, { size: 150, inode: 9 })).toEqual({
      byteOffset: 100,
      lineCount: 4,
      rewritten: false,
    });
  });

  it("restarts when the file shrank below the offset", () => {
    expect(readStart(state, { size: 99, inode: 7 })).toEqual({
      byteOffset: 0,
      lineCount: 0,
      rewritten: true,
    });
  });

  it("restarts when the inode changed (the file was replaced)", () => {
    expect(readStart(state, { size: 500, inode: 8 })).toEqual({
      byteOffset: 0,
      lineCount: 0,
      rewritten: true,
    });
  });
});

describe("readCompleteLines", () => {
  it("reads every complete line with offsets and 1-based numbers", () => {
    const { lines, result } = collect(file("a\nbb\nccc\n"));
    expect(lines).toEqual([
      ["a", 0, 1],
      ["bb", 2, 2],
      ["ccc", 5, 3],
    ]);
    expect(result).toEqual({ byteOffset: 9, lineCount: 3, linesRead: 3 });
  });

  it("leaves a trailing fragment unconsumed, and reads it once completed", () => {
    const path = file("a\nbb");
    const first = collect(path);
    expect(first.lines).toEqual([["a", 0, 1]]);
    expect(first.result).toEqual({ byteOffset: 2, lineCount: 1, linesRead: 1 });
    appendFileSync(path, "b\n");
    const second = collect(path, first.result);
    expect(second.lines).toEqual([["bbb", 2, 2]]);
    expect(second.result).toEqual({ byteOffset: 6, lineCount: 2, linesRead: 1 });
  });

  it("returns the same offset and no lines when nothing new is complete", () => {
    const path = file("a\n");
    const { lines, result } = collect(path, { byteOffset: 2, lineCount: 1 });
    expect(lines).toEqual([]);
    expect(result).toEqual({ byteOffset: 2, lineCount: 1, linesRead: 0 });
  });

  it("handles lines longer than the chunk size and chunks ending mid-line", () => {
    const { lines, result } = collect(file("abcdefgh\nij\nk\n"), undefined, 3);
    expect(lines).toEqual([
      ["abcdefgh", 0, 1],
      ["ij", 9, 2],
      ["k", 12, 3],
    ]);
    expect(result.byteOffset).toBe(14);
  });

  it("keeps each line's bytes intact after later chunks reuse the read buffer", () => {
    const collected: Buffer[] = [];
    readCompleteLines(
      file("one\ntwo\nthree\n"),
      { byteOffset: 0, lineCount: 0 },
      (line) => collected.push(line.bytes),
      4,
    );
    expect(collected.map((bytes) => bytes.toString())).toEqual(["one", "two", "three"]);
  });

  it("never requests more than one chunk per read", () => {
    const lengths: number[] = [];
    /** The real filesystem, recording each requested read length. */
    const spyFs: ReaderFs = {
      ...NODE_READER_FS,
      read: (fd, buffer, length, position) => {
        lengths.push(length);
        return NODE_READER_FS.read(fd, buffer, length, position);
      },
    };
    const path = file(`${"x".repeat(1000)}\n`);
    readCompleteLines(path, { byteOffset: 0, lineCount: 0 }, () => undefined, 16, spyFs);
    expect(Math.max(...lengths)).toBe(16);
    expect(lengths.length).toBeGreaterThan(60);
  });

  it("keeps carriage returns: CRLF lines are split on LF with the exact bytes preserved", () => {
    const { lines } = collect(file("a\r\nb\r\n"));
    expect(lines).toEqual([
      ["a\r", 0, 1],
      ["b\r", 3, 2],
    ]);
  });

  it("reports empty lines as zero-length lines", () => {
    expect(collect(file("\n\nx\n")).lines).toEqual([
      ["", 0, 1],
      ["", 1, 2],
      ["x", 2, 3],
    ]);
  });

  it("reads nothing from an empty file", () => {
    expect(collect(file("")).result).toEqual({ byteOffset: 0, lineCount: 0, linesRead: 0 });
  });

  it("preserves multi-byte UTF-8 split across chunk boundaries", () => {
    const text = "café 日本\n";
    const { lines } = collect(file(text), undefined, 2);
    expect(lines).toEqual([["café 日本", 0, 1]]);
  });

  it("closes the file descriptor even when a read throws", () => {
    let closed = 0;
    /** A filesystem whose reads always fail. */
    const failingFs: ReaderFs = {
      open: () => 42,
      read: () => {
        throw new Error("EIO");
      },
      close: () => {
        closed += 1;
      },
    };
    expect(() =>
      readCompleteLines("/any", { byteOffset: 0, lineCount: 0 }, () => undefined, 8, failingFs),
    ).toThrow("EIO");
    expect(closed).toBe(1);
  });

  it("leaves fixture 03's run-1 fragment unconsumed", () => {
    const path = join(
      import.meta.dirname,
      "../../../../fixtures/03-trailing-fragment/run-1/projects/-fixture-demo/s03.jsonl",
    );
    const { result } = collect(path);
    const size = readFileSync(path).length;
    expect(result.linesRead).toBe(2);
    expect(size - result.byteOffset).toBe(40);
  });
});
