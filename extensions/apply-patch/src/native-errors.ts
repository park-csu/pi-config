const RUST_LINUX_ERRORS: Readonly<Record<string, string>> = {
  ENOENT: "No such file or directory (os error 2)",
  EACCES: "Permission denied (os error 13)",
  EPERM: "Operation not permitted (os error 1)",
  EISDIR: "Is a directory (os error 21)",
  ENOTDIR: "Not a directory (os error 20)",
  ELOOP: "Symbolic link loop (os error 40)",
  ENOSPC: "No space left on device (os error 28)",
};

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function invalidUtf8(length: number, index: number): string {
  return `invalid utf-8 sequence of ${length} bytes from index ${index}`;
}

/**
 * Returns the display text Rust uses for the first UTF-8 validation error.
 */
export function utf8Error(bytes: Uint8Array): string | undefined {
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    let width: 2 | 3 | 4;

    if (first <= 0x7f) {
      index++;
      continue;
    } else if (first >= 0xc2 && first <= 0xdf) {
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      width = 4;
    } else {
      return invalidUtf8(1, index);
    }

    const second = bytes[index + 1];
    if (second === undefined) {
      return `incomplete utf-8 byte sequence from index ${index}`;
    }
    if (
      !isContinuation(second) ||
      (first === 0xe0 && second < 0xa0) ||
      (first === 0xed && second > 0x9f) ||
      (first === 0xf0 && second < 0x90) ||
      (first === 0xf4 && second > 0x8f)
    ) {
      return invalidUtf8(1, index);
    }

    for (let offset = 2; offset < width; offset++) {
      const byte = bytes[index + offset];
      if (byte === undefined) {
        return `incomplete utf-8 byte sequence from index ${index}`;
      }
      if (!isContinuation(byte)) {
        return invalidUtf8(offset, index);
      }
    }
    index += width;
  }
  return undefined;
}

/**
 * Formats the Linux errno text used by Rust's std::io::Error.
 *
 * The fallback deliberately keeps the original error message; callers can
 * still report errors that are outside this small native-error compatibility
 * surface.
 */
export function ioError(error: unknown): string {
  const value = typeof error === "object" && error !== null
    ? error as { code?: unknown; message?: unknown }
    : undefined;
  if (typeof value?.code === "string") {
    const rustMessage = RUST_LINUX_ERRORS[value.code];
    if (rustMessage !== undefined) return rustMessage;
  }
  if (typeof value?.message === "string") return value.message;
  return String(error);
}

/** The native handler wraps verification errors, unlike the standalone CLI. */
export function verificationError(message: string): string {
  const display = message
    .replace(/^Invalid patch: /, "invalid patch: ")
    .replace(/^Invalid patch hunk on line (\d+): /, "invalid hunk at line $1, ")
    .replace(/^multiple operations target /, "invalid patch: multiple operations target ");
  return `apply_patch verification failed: ${display}`;
}
