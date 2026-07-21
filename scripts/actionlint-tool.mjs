import path from "node:path";

export const ACTIONLINT_VERSION = "1.7.12";
export const ACTIONLINT_RELEASE_BASE = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}`;

export const ACTIONLINT_TARGETS = Object.freeze({
  "linux-x64": {
    archiveName: "actionlint_1.7.12_linux_amd64.tar.gz",
    archiveSha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    binaryName: "actionlint",
    binarySha256: "c872d6db8c6bf83a8eaa704fc93999f027d55dffbc63b8a6abdccb47df5f4cd4",
    archiveKind: "tar-gzip",
  },
  "linux-arm64": {
    archiveName: "actionlint_1.7.12_linux_arm64.tar.gz",
    archiveSha256: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
    binaryName: "actionlint",
    binarySha256: "ac0323433c2853ec3fb978c611430c5b3dc5d43c58d1a1ec031b00ab572beb60",
    archiveKind: "tar-gzip",
  },
  "darwin-x64": {
    archiveName: "actionlint_1.7.12_darwin_amd64.tar.gz",
    archiveSha256: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    binaryName: "actionlint",
    binarySha256: "d1f7cee75ae2873609bd9567b4600bebc5315a5e733e73202987a44fafdd53b2",
    archiveKind: "tar-gzip",
  },
  "darwin-arm64": {
    archiveName: "actionlint_1.7.12_darwin_arm64.tar.gz",
    archiveSha256: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    binaryName: "actionlint",
    binarySha256: "8db11704dc296f096216db4db65d86cd7f0ebfdf4c38453a1da276b137b88388",
    archiveKind: "tar-gzip",
  },
  "win32-x64": {
    archiveName: "actionlint_1.7.12_windows_amd64.zip",
    archiveSha256: "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
    binaryName: "actionlint.exe",
    binarySha256: "54ca21be3de4c7cfa26914aa8b61bd76bf573ef3caac5f80d110558cdf241718",
    archiveKind: "zip",
  },
  "win32-arm64": {
    archiveName: "actionlint_1.7.12_windows_arm64.zip",
    archiveSha256: "cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41",
    binaryName: "actionlint.exe",
    binarySha256: "dc172c9dd32275b4a563143a318a48c91dff44fabafb23b7d1a05ed9c106a488",
    archiveKind: "zip",
  },
});

export function currentActionlintTarget() {
  const key = `${process.platform}-${process.arch}`;
  const target = ACTIONLINT_TARGETS[key];
  if (target === undefined) {
    throw new Error(
      `actionlint v${ACTIONLINT_VERSION} bootstrap does not support ${key}; use a supported x64/arm64 Linux, macOS, or Windows host`,
    );
  }
  return { key, ...target };
}

export function localActionlintPath(root, target = currentActionlintTarget()) {
  return path.join(
    root,
    ".local",
    "tools",
    `actionlint-${ACTIONLINT_VERSION}`,
    target.key,
    target.binaryName,
  );
}
