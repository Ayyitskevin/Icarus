import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";

import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";

export const CHANGE_HANDOFF_FILENAME = "icarus-change-handoff.json";
export const CHANGE_HANDOFF_RESULT_FILENAME = "icarus-change-handoff-result.json";
export const CHANGE_HANDOFF_MAX_BYTES = 64 * 1024;
export const CHANGE_HANDOFF_RESULT_MAX_BYTES = 2 * 1024;

export interface SecureFileRead {
  readonly bytes: Buffer;
  readonly sha256: string;
}

function fail(code: string, message: string): never {
  throw new IcarusError(code, message);
}

function noFollowFlag(code: string): number {
  const flag = fsConstants.O_NOFOLLOW;
  if (typeof flag === "number" && flag !== 0) return flag;
  return fail(code, "This platform cannot safely open handoff files without following links");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertNoSymlinkComponents(
  absolutePath: string,
  includeFinal: boolean,
  errorCode = "HANDOFF_FILE_UNSAFE",
): void {
  const parsed = path.parse(absolutePath);
  const parts = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const limit = includeFinal ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    const part = parts[index];
    if (part === undefined) fail(errorCode, "Handoff path is unsafe");
    current = path.join(current, part);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) fail(errorCode, "Handoff path contains a symbolic link");
    if (index < limit - 1 && !stat.isDirectory()) {
      fail(errorCode, "Handoff path has a non-directory ancestor");
    }
  }
}

function assertOwnedPrivateRegular(stat: BigIntStats, maxBytes: number): void {
  const currentUid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (currentUid !== undefined && stat.uid !== BigInt(currentUid))
  ) {
    fail("HANDOFF_FILE_UNSAFE", "Handoff input is not an owned single-link regular file");
  }
  if ((stat.mode & 0o177n) !== 0n) {
    fail("HANDOFF_FILE_UNSAFE", "Handoff input permissions are not owner-only and non-executable");
  }
  if (stat.size < 1n || stat.size > BigInt(maxBytes)) {
    fail("HANDOFF_FILE_TOO_LARGE", "Handoff input exceeds its byte limit");
  }
}

export function readSecureHandoffFile(inputPath: string, maxBytes: number): SecureFileRead {
  if (process.platform !== "linux") {
    fail("HANDOFF_FILE_UNSUPPORTED", "Secure handoff file reads are unsupported on this platform");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail("INVALID_HANDOFF_FILE", "Handoff file byte limit is invalid");
  }
  const noFollow = noFollowFlag("HANDOFF_FILE_UNSUPPORTED");
  const absolutePath = path.resolve(inputPath);
  let descriptor: number | undefined;
  try {
    assertNoSymlinkComponents(absolutePath, true);
    const before = lstatSync(absolutePath, { bigint: true });
    assertOwnedPrivateRegular(before, maxBytes);
    if (realpathSync(absolutePath) !== absolutePath) {
      fail("HANDOFF_FILE_UNSAFE", "Handoff input path identity is unsafe");
    }
    descriptor = openSync(absolutePath, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    assertOwnedPrivateRegular(opened, maxBytes);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("HANDOFF_FILE_CHANGED", "Handoff input identity changed during validation");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) fail("HANDOFF_FILE_TOO_LARGE", "Handoff input exceeds its byte limit");

    const finished = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(absolutePath, { bigint: true });
    if (
      !sameIdentity(opened, finished) ||
      finished.dev !== current.dev ||
      finished.ino !== current.ino ||
      realpathSync(absolutePath) !== absolutePath
    ) {
      fail("HANDOFF_FILE_CHANGED", "Handoff input changed while it was read");
    }
    const bytes = Buffer.concat(chunks, total);
    return { bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof IcarusError) throw error;
    throw new IcarusError("HANDOFF_FILE_UNSAFE", "Handoff input could not be read safely");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The primary validation error remains authoritative.
      }
    }
  }
}

function assertPrivateParentDirectory(stat: BigIntStats): void {
  const currentUid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    currentUid === undefined ||
    stat.uid !== BigInt(currentUid) ||
    (stat.mode & 0o022n) !== 0n
  ) {
    fail(
      "HANDOFF_EXPORT_UNSAFE",
      "Handoff output parent directory must be owner-controlled and non-writable by others",
    );
  }
}

function assertPrivateDirectory(stat: BigIntStats): void {
  const currentUid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (currentUid !== undefined && stat.uid !== BigInt(currentUid))
  ) {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output directory is unsafe");
  }
  if ((stat.mode & 0o777n) !== 0o700n) {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output directory must have mode 0700");
  }
}

function descriptorRoot(directoryDescriptor: number): string {
  if (process.platform !== "linux") {
    fail(
      "HANDOFF_EXPORT_UNSUPPORTED",
      "Descriptor-relative handoff export is unsupported on this platform",
    );
  }
  const root = `/proc/self/fd/${directoryDescriptor}`;
  try {
    const opened = fstatSync(directoryDescriptor, { bigint: true });
    const throughDescriptor = statSync(root, { bigint: true });
    if (
      !opened.isDirectory() ||
      !throughDescriptor.isDirectory() ||
      opened.dev !== throughDescriptor.dev ||
      opened.ino !== throughDescriptor.ino
    ) {
      fail(
        "HANDOFF_EXPORT_UNSUPPORTED",
        "Descriptor-relative handoff export is unavailable in this environment",
      );
    }
  } catch (error) {
    if (error instanceof IcarusError) throw error;
    throw new IcarusError(
      "HANDOFF_EXPORT_UNSUPPORTED",
      "Descriptor-relative handoff export is unavailable in this environment",
    );
  }
  return root;
}

interface CreatedFile {
  readonly name: string;
  readonly descriptor: number;
  readonly identity: BigIntStats;
}

function assertPrivateCreatedFile(stat: BigIntStats, expectedSize: number): void {
  const currentUid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size !== BigInt(expectedSize) ||
    (currentUid !== undefined && stat.uid !== BigInt(currentUid))
  ) {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output file identity is unsafe");
  }
  if ((stat.mode & 0o777n) !== 0o600n || (stat.mode & 0o177n) !== 0n) {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output file permissions are unsafe");
  }
}

function openExclusiveAt(
  directoryRoot: string,
  name: string,
  register: (created: CreatedFile) => void,
): CreatedFile {
  const descriptor = openSync(
    path.join(directoryRoot, name),
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      noFollowFlag("HANDOFF_EXPORT_UNSUPPORTED"),
    0o600,
  );
  let identity: BigIntStats;
  try {
    identity = fstatSync(descriptor, { bigint: true });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  const created = { name, descriptor, identity };
  register(created);
  assertPrivateCreatedFile(identity, 0);
  return created;
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) fail("HANDOFF_EXPORT_FAILED", "Handoff output could not be written");
    offset += written;
  }
}

function cleanupCreatedFile(directoryRoot: string, created: CreatedFile): void {
  const child = path.join(directoryRoot, created.name);
  try {
    const descriptorStat = fstatSync(created.descriptor, { bigint: true });
    const current = lstatSync(child, { bigint: true });
    if (
      descriptorStat.isFile() &&
      descriptorStat.dev === created.identity.dev &&
      descriptorStat.ino === created.identity.ino &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === descriptorStat.dev &&
      current.ino === descriptorStat.ino
    ) {
      unlinkSync(child);
    }
  } catch {
    // Cleanup is best effort and never widens the deletion target.
  }
}

function assertCreatedFileStable(
  directoryRoot: string,
  created: CreatedFile,
  expectedSize: number,
): void {
  const descriptorStat = fstatSync(created.descriptor, { bigint: true });
  const pathStat = lstatSync(path.join(directoryRoot, created.name), { bigint: true });
  assertPrivateCreatedFile(descriptorStat, expectedSize);
  assertPrivateCreatedFile(pathStat, expectedSize);
  if (
    descriptorStat.dev !== created.identity.dev ||
    descriptorStat.ino !== created.identity.ino ||
    pathStat.dev !== created.identity.dev ||
    pathStat.ino !== created.identity.ino
  ) {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output file identity changed");
  }
}

function assertDirectoryPathStable(absoluteDirectory: string, identity: BigIntStats): void {
  assertNoSymlinkComponents(absoluteDirectory, true, "HANDOFF_EXPORT_UNSAFE");
  const current = lstatSync(absoluteDirectory, { bigint: true });
  assertPrivateDirectory(current);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    realpathSync(absoluteDirectory) !== absoluteDirectory
  ) {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output directory identity changed");
  }
}

function assertParentDirectoryPathStable(absoluteDirectory: string, identity: BigIntStats): void {
  assertNoSymlinkComponents(absoluteDirectory, true, "HANDOFF_EXPORT_UNSAFE");
  const current = lstatSync(absoluteDirectory, { bigint: true });
  assertPrivateParentDirectory(current);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    realpathSync(absoluteDirectory) !== absoluteDirectory
  ) {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output parent directory identity changed");
  }
}

export function writeChangeHandoffFiles(
  outputDirectory: string,
  payloadBytes: Uint8Array,
  resultBytes: Uint8Array,
): void {
  if (process.platform !== "linux") {
    fail(
      "HANDOFF_EXPORT_UNSUPPORTED",
      "Descriptor-relative handoff export is unsupported on this platform",
    );
  }
  const noFollow = noFollowFlag("HANDOFF_EXPORT_UNSUPPORTED");
  const directoryOnly = fsConstants.O_DIRECTORY;
  if (typeof directoryOnly !== "number" || directoryOnly === 0) {
    fail("HANDOFF_EXPORT_UNSUPPORTED", "This platform cannot safely open an output directory");
  }

  const absoluteDirectory = path.resolve(outputDirectory);
  const parentDirectory = path.dirname(absoluteDirectory);
  const outputName = path.basename(absoluteDirectory);
  if (outputName.length === 0 || outputName === "." || outputName === "..") {
    fail("HANDOFF_EXPORT_UNSAFE", "Handoff output directory name is invalid");
  }

  let parentDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let directoryRoot: string | undefined;
  const created: CreatedFile[] = [];
  let succeeded = false;
  try {
    assertNoSymlinkComponents(parentDirectory, true, "HANDOFF_EXPORT_UNSAFE");
    const parentBefore = lstatSync(parentDirectory, { bigint: true });
    assertPrivateParentDirectory(parentBefore);
    if (realpathSync(parentDirectory) !== parentDirectory) {
      fail("HANDOFF_EXPORT_UNSAFE", "Handoff output parent directory is unsafe");
    }

    parentDescriptor = openSync(parentDirectory, fsConstants.O_RDONLY | directoryOnly | noFollow);
    const openedParent = fstatSync(parentDescriptor, { bigint: true });
    assertPrivateParentDirectory(openedParent);
    if (openedParent.dev !== parentBefore.dev || openedParent.ino !== parentBefore.ino) {
      fail("HANDOFF_EXPORT_UNSAFE", "Handoff output parent directory identity changed");
    }
    const parentRoot = descriptorRoot(parentDescriptor);
    assertParentDirectoryPathStable(parentDirectory, openedParent);

    try {
      mkdirSync(path.join(parentRoot, outputName), { mode: 0o700 });
      fsyncSync(parentDescriptor);
      assertParentDirectoryPathStable(parentDirectory, openedParent);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "EEXIST"
      ) {
        throw error;
      }
    }

    assertParentDirectoryPathStable(parentDirectory, openedParent);
    assertNoSymlinkComponents(absoluteDirectory, true, "HANDOFF_EXPORT_UNSAFE");
    const before = lstatSync(absoluteDirectory, { bigint: true });
    assertPrivateDirectory(before);
    if (realpathSync(absoluteDirectory) !== absoluteDirectory) {
      fail("HANDOFF_EXPORT_UNSAFE", "Handoff output directory identity is unsafe");
    }

    directoryDescriptor = openSync(
      path.join(parentRoot, outputName),
      fsConstants.O_RDONLY | directoryOnly | noFollow,
    );
    const openedDirectory = fstatSync(directoryDescriptor, { bigint: true });
    assertPrivateDirectory(openedDirectory);
    if (openedDirectory.dev !== before.dev || openedDirectory.ino !== before.ino) {
      fail("HANDOFF_EXPORT_UNSAFE", "Handoff output directory identity changed");
    }
    directoryRoot = descriptorRoot(directoryDescriptor);
    assertParentDirectoryPathStable(parentDirectory, openedParent);

    const register = (file: CreatedFile): void => {
      created.push(file);
    };
    const payloadFile = openExclusiveAt(directoryRoot, CHANGE_HANDOFF_FILENAME, register);
    writeAll(payloadFile.descriptor, payloadBytes);
    fsyncSync(payloadFile.descriptor);
    assertCreatedFileStable(directoryRoot, payloadFile, payloadBytes.byteLength);

    const resultFile = openExclusiveAt(directoryRoot, CHANGE_HANDOFF_RESULT_FILENAME, register);
    writeAll(resultFile.descriptor, resultBytes);
    fsyncSync(resultFile.descriptor);
    assertCreatedFileStable(directoryRoot, resultFile, resultBytes.byteLength);

    assertDirectoryPathStable(absoluteDirectory, openedDirectory);
    fsyncSync(directoryDescriptor);
    assertDirectoryPathStable(absoluteDirectory, openedDirectory);
    assertParentDirectoryPathStable(parentDirectory, openedParent);
    fsyncSync(parentDescriptor);
    assertDirectoryPathStable(absoluteDirectory, openedDirectory);
    assertParentDirectoryPathStable(parentDirectory, openedParent);
    succeeded = true;
  } catch (error) {
    if (error instanceof IcarusError) throw error;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "EEXIST") {
      throw new IcarusError("HANDOFF_EXPORT_EXISTS", "Handoff export refuses to overwrite files");
    }
    throw new IcarusError("HANDOFF_EXPORT_FAILED", "Handoff export failed safely");
  } finally {
    if (!succeeded && directoryDescriptor !== undefined && directoryRoot !== undefined) {
      for (const file of [...created].reverse()) cleanupCreatedFile(directoryRoot, file);
      try {
        fsyncSync(directoryDescriptor);
      } catch {
        // The primary export error remains authoritative.
      }
    }
    for (const file of created) {
      try {
        closeSync(file.descriptor);
      } catch {
        // The primary export result remains authoritative.
      }
    }
    if (directoryDescriptor !== undefined) {
      try {
        closeSync(directoryDescriptor);
      } catch {
        // The primary export result remains authoritative.
      }
    }
    if (parentDescriptor !== undefined) {
      try {
        closeSync(parentDescriptor);
      } catch {
        // The primary export result remains authoritative.
      }
    }
  }
}
