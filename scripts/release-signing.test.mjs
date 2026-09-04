import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWindowsCodeSigningCert, signUpdaterBundle } from "./release-signing.mjs";

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const next = values[key];
    if (next == null) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("uses a provided Authenticode thumbprint", () => {
  const thumbprint = "a".repeat(40);
  withEnv(
    {
      PIDECK_WINDOWS_CERT_THUMBPRINT: thumbprint,
      WINDOWS_CERTIFICATE: undefined,
      WINDOWS_CERTIFICATE_PASSWORD: undefined,
    },
    () => {
      assert.deepEqual(ensureWindowsCodeSigningCert(), {
        thumbprint,
        created: false,
        subject: thumbprint,
        kind: "provided",
      });
    },
  );
});

test("re-signs the updater bundle and requires a non-empty signature", () => {
  const root = mkdtempSync(join(tmpdir(), "updater-sign-"));
  const cli = join(root, "apps", "desktop", "node_modules", "@tauri-apps", "cli");
  mkdirSync(cli, { recursive: true });
  const installer = join(root, "PaperMatrix_0.2.8_x64-setup.exe");
  writeFileSync(installer, "final Authenticode-signed bytes");
  writeFileSync(join(cli, "tauri.js"), "placeholder");
  const keyPath = join(root, "apps", "desktop", "src-tauri", ".tauri-updater.key");
  mkdirSync(join(root, "apps", "desktop", "src-tauri"), { recursive: true });
  writeFileSync(keyPath, "test private key");

  let signerArgs;
  const signaturePath = withEnv({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" }, () =>
    signUpdaterBundle(installer, root, (_command, args) => {
      signerArgs = args;
      writeFileSync(`${args.at(-1)}.sig`, "minisign signature for final bytes\n");
      return { status: 0 };
    }),
  );

  assert.equal(signerArgs.at(-2), "");
  assert.equal(signaturePath, `${installer}.sig`);
  assert.equal(readFileSync(signaturePath, "utf8"), "minisign signature for final bytes\n");
});

test("rejects a partial Windows PFX secret pair", () => {
  withEnv(
    {
      PIDECK_WINDOWS_CERT_THUMBPRINT: undefined,
      WINDOWS_CERTIFICATE: "dGVzdA==",
      WINDOWS_CERTIFICATE_PASSWORD: undefined,
    },
    () => {
      assert.throws(
        () => ensureWindowsCodeSigningCert(),
        /WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must be configured together/,
      );
    },
  );
});
