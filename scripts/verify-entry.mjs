// Verifies the pi extension entry (dist/index.js): the default export is a
// factory that registers exactly the expected event handlers. pi itself is a
// peer (types only), so we pass a fake ExtensionAPI — one that THROWS on any
// surface beyond the eight on() overloads this extension uses, so a drift
// toward an unsupported pi surface fails here instead of in a live session.
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js missing — run `npm run build` first");
  process.exit(1);
}

// Keep register()'s store base dir (under $HOME/.pi/agent/cortext) out of the
// real home in case a future change touches the filesystem at registration.
process.env.HOME = mkdtempSync(join(tmpdir(), "cortext-verify-home-"));

const mod = await import(join(root, "dist", "index.js"));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

if (typeof mod.default !== "function") fail("default export is not a factory function");
if (typeof mod.register !== "function") fail("named register export missing");

const SUPPORTED = [
  "session_start",
  "session_shutdown",
  "message_start",
  "message_update",
  "message_end",
  "before_agent_start",
  "context",
  "session_before_compact",
];
const registered = [];
const api = {
  on: (event, handler) => {
    if (!SUPPORTED.includes(event)) fail(`registered handler for an unsupported event: ${event}`);
    if (typeof handler !== "function") fail(`handler for ${event} is not a function`);
    if (registered.includes(event)) fail(`duplicate handler for ${event}`);
    registered.push(event);
  },
};

mod.default(api);
for (const event of SUPPORTED) {
  if (!registered.includes(event)) fail(`expected handler for ${event} not registered`);
}
if (registered.length !== SUPPORTED.length) fail(`registered ${registered.length} handlers, expected ${SUPPORTED.length}`);

console.log(`entry OK: factory registered ${registered.length} handlers: ${registered.join(", ")}`);
