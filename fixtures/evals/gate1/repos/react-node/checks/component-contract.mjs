import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const componentPath = new URL("../src/StatusCard.jsx", import.meta.url);
const component = await readFile(componentPath, "utf8");

assert.match(component, /from "\.\/status\.mjs";/u);
assert.match(component, /data-tone=\{statusTone\(isOnline\)\}/u);
assert.match(component, /\{statusLabel\(isOnline\)\}/u);
assert.doesNotMatch(component, />Online</u);
assert.doesNotMatch(component, />Offline</u);
