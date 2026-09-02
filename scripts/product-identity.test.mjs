import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Windows app identity is PaperMatrix, not pideck", () => {
  const tauri = JSON.parse(
    readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.equal(tauri.productName, "PaperMatrix");
  assert.equal(tauri.mainBinaryName, "PaperMatrix");
  assert.equal(tauri.identifier, "online.papermatrix.matrix-agent");
  assert.equal(tauri.bundle.publisher, "PaperMatrix");
  assert.doesNotMatch(tauri.identifier, /pideck/i);
  assert.doesNotMatch(tauri.mainBinaryName, /pideck/i);

  const cargo = readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
  assert.match(cargo, /^name = "PaperMatrix"$/m);
  assert.match(cargo, /^default-run = "PaperMatrix"$/m);

  const hooks = readFileSync(join(root, "apps/desktop/src-tauri/windows/hooks.nsh"), "utf8");
  assert.match(hooks, /PaperMatrix\.exe/);
  assert.doesNotMatch(hooks, /RMDir \/r "\$PROFILE\\\.pi"/i);
  assert.doesNotMatch(hooks, /RMDir \/r "\$LOCALAPPDATA\\com\.skitre\.pideck"/i);
  const uninstall = hooks.split("!macro NSIS_HOOK_PREUNINSTALL")[1] ?? "";
  assert.match(uninstall, /PaperMatrix\.exe/);
  assert.doesNotMatch(uninstall, /pideck\.exe/i);
  const postUninstall = hooks.split("!macro NSIS_HOOK_POSTUNINSTALL")[1] ?? "";
  assert.match(postUninstall, /\\.MatrixAgent/);
  assert.match(postUninstall, /online\.papermatrix\.matrix-agent\\host/);
});
