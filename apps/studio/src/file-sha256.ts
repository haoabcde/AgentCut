import { createSHA256 } from "hash-wasm";

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export interface FileSha256Options {
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (processedBytes: number, totalBytes: number) => void;
}

export async function sha256File(
  file: Blob,
  options: FileSha256Options = {},
): Promise<string> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("SHA-256 chunk size must be a positive integer");
  }
  if (file.size <= 0) {
    throw new Error("Evidence file must not be empty");
  }

  throwIfAborted(options.signal);
  const hasher = await createSHA256();
  hasher.init();

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(offset + chunkSize, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    throwIfAborted(options.signal);
    hasher.update(bytes);
    options.onProgress?.(end, file.size);
  }

  throwIfAborted(options.signal);
  return `sha256:${hasher.digest("hex")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Evidence hashing was cancelled", "AbortError");
  }
}
