import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureWindowsCodeSigningCert,
  signWindowsPe,
  verifyWindowsPe,
} from "./release-signing.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultInstaller = join(
  root,
  "apps/desktop/src-tauri/target/release/bundle/nsis/PaperMatrix_0.2.2_x64-setup.exe",
);
const defaultExe = join(root, "apps/desktop/src-tauri/target/release/pideck.exe");
const targets = process.argv.slice(2);
const files = (targets.length ? targets : [defaultInstaller, defaultExe]).filter((path) =>
  existsSync(path),
);
if (files.length === 0) {
  console.error("No installer or exe to sign. Pass paths or run pnpm package:release first.");
  process.exit(1);
}
const cert = ensureWindowsCodeSigningCert();
console.log(`[sign] using ${cert.subject || "certificate"} ${cert.thumbprint}`);
for (const file of files) {
  const result = signWindowsPe(file, cert.thumbprint);
  const verify = verifyWindowsPe(file);
  console.log(`[sign] ${file}`);
  console.log(`       timestamp=${result.timestampUrl ?? "none (self-signed local)"}`);
  console.log(`       verify=${verify.ok ? "ok" : "failed"}`);
  if (!verify.ok) {
    console.error(verify.output);
    process.exit(1);
  }
}
