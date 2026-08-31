const REQUIRED_RANGE = ">=22.23.0 <23";

const [major, minor, patch] = process.versions.node.split(".").map(Number);
const supported = major === 22 && (minor > 23 || (minor === 23 && patch >= 0));

if (!supported) {
  console.error(
    `Unsupported Node.js v${process.versions.node}. Icarus requires ${REQUIRED_RANGE}. ` +
      `Run "nvm use" (.nvmrc pins Node 22.23.2) before pnpm commands; ` +
      `otherwise native modules may fail with an ABI mismatch.`,
  );
  process.exit(1);
}
