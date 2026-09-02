import assert from "node:assert/strict";
import test from "node:test";
import { ensureWindowsCodeSigningCert } from "./release-signing.mjs";

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
