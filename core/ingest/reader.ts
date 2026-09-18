/**
 * @file Reading complete lines from a file, starting at a stored byte offset (docs/development.md P4.2, D-003).
 *
 * The reader never loads a whole file: it reads fixed-size chunks and hands each complete line to
 * a callback. A trailing fragment without a newline isn't consumed, so the next run reads it once
 * it's complete. Counting a half-written line and then skipping it forever is how phuryn's scanner
 * lost turns.
 */
import { closeSync, openSync, readSync } from "node:fs";

/** What ingestion remembers about a file between runs. */
export interface FileState {
  /** Position just past the last complete line consumed. */
  readonly byteOffset: number;
  /** Number of complete lines before `byteOffset`. */
  readonly lineCount: number;
  /** File size at the last read. */
  readonly size: number;
  /** Inode at the last read, or null where the platform has none. */
  readonly inode: number | null;
}

/** The current size and inode of a file. */
export interface FileStat {
  /** Size in bytes. */
  readonly size: number;
  /** Inode, or null where the platform has none. */
  readonly inode: number | null;
}

/** Where to start reading a file this run. */
export interface ReadStart {
  /** Byte offset to read from. */
  readonly byteOffset: number;
  /** Complete lines before that offset, so new lines get the right line numbers. */
  readonly lineCount: number;
  /** True when the file was replaced or truncated since the last read, so reading restarts at 0. */
  readonly rewritten: boolean;
}

/**
 * Decides where to resume reading a file.
 * @param state - What was stored after the last read, or null for a file never seen.
 * @param stat - The file's current size and inode.
 * @returns The offset and line count to start from, and whether a rewrite was detected.
 */
export function readStart(state: FileState | null, stat: FileStat): ReadStart {
  if (state === null) {
    return { byteOffset: 0, lineCount: 0, rewritten: false };
  }
  // A shorter file or a different inode means the bytes before our offset are no longer the ones
  // we read. Restart; raw-line identity makes rereading unchanged lines a no-op (D-002).
  const inodeChanged = state.inode !== null && stat.inode !== null && state.inode !== stat.inode;
  if (stat.size < state.byteOffset || inodeChanged) {
    return { byteOffset: 0, lineCount: 0, rewritten: true };
  }
  return { byteOffset: state.byteOffset, lineCount: state.lineCount, rewritten: false };
}

/** A position to resume reading from: an offset and the count of complete lines before it. */
export type ResumePoint = Pick<ReadStart, "byteOffset" | "lineCount">;

/** One complete line handed to the callback. */
export interface CompleteLine {
  /** The line's bytes, without the terminating newline. */
  readonly bytes: Buffer;
  /** Byte offset of the line's first byte. */
  readonly offset: number;
  /** 1-based line number. */
  readonly lineNumber: number;
}

/** Result of reading a file to its last complete line. */
export interface ReadResult {
  /** Offset just past the last complete line; the next run starts here. */
  readonly byteOffset: number;
  /** Complete lines before `byteOffset`. */
  readonly lineCount: number;
  /** Complete lines read this call. */
  readonly linesRead: number;
}

/** Default chunk size: large enough to be fast, small enough to bound memory on huge files. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** The file operations the reader needs, injectable so chunking can be observed in tests. */
export interface ReaderFs {
  /** Opens a file for reading and returns a descriptor. */
  readonly open: (path: string) => number;
  /** Reads up to `length` bytes at `position` into `buffer`; returns bytes read (0 at end). */
  readonly read: (fd: number, buffer: Buffer, length: number, position: number) => number;
  /** Closes a descriptor. */
  readonly close: (fd: number) => void;
}

/** The real filesystem implementation of {@link ReaderFs}. */
export const NODE_READER_FS: ReaderFs = {
  open: (path) => openSync(path, "r"),
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  close: (fd) => {
    closeSync(fd);
  },
};

/**
 * Reads every complete line after `start`, calling `onLine` for each, in file order.
 * @param path - File to read.
 * @param start - Offset and line count to resume from.
 * @param onLine - Receives each complete line.
 * @param chunkSize - Bytes requested per read.
 * @param fs - File operations; defaults to the real filesystem.
 * @returns The new offset and line count, and how many lines were read.
 * @throws {Error} Whatever the filesystem throws opening or reading; the descriptor is always closed.
 */
export function readCompleteLines(
  path: string,
  start: ResumePoint,
  onLine: (line: CompleteLine) => void,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  fs: ReaderFs = NODE_READER_FS,
): ReadResult {
  const fd = fs.open(path);
  try {
    const chunk = Buffer.alloc(chunkSize);
    // Bytes read but not yet ending in a newline: the start of a line that continues in the next chunk.
    let pending: Buffer = Buffer.alloc(0);
    let pendingOffset = start.byteOffset;
    let position = start.byteOffset;
    let lineCount = start.lineCount;
    let linesRead = 0;
    for (;;) {
      const bytesRead = fs.read(fd, chunk, chunkSize, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      const data =
        pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let lineStart = 0;
      for (
        let newline = data.indexOf(0x0a);
        newline !== -1;
        newline = data.indexOf(0x0a, lineStart)
      ) {
        lineCount += 1;
        linesRead += 1;
        // Copy: `data` may be the reusable chunk buffer, which the next read overwrites.
        onLine({
          bytes: Buffer.from(data.subarray(lineStart, newline)),
          offset: pendingOffset + lineStart,
          lineNumber: lineCount,
        });
        lineStart = newline + 1;
      }
      pendingOffset += lineStart;
      pending = Buffer.from(data.subarray(lineStart));
    }
    // Whatever is still pending has no newline yet; the offset stays before it.
    return { byteOffset: pendingOffset, lineCount, linesRead };
  } finally {
    fs.close(fd);
  }
}
