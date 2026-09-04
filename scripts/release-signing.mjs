/**
 * Release signing helpers:
 * - Tauri updater minisign private key (TAURI_SIGNING_PRIVATE_KEY)
 * - Windows Authenticode via signtool + a local or provided certificate
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const UPDATER_KEY_REL = "apps/desktop/src-tauri/.tauri-updater.key";
const DEV_CERT_SUBJECT = "CN=PaperMatrix";

function spawnCapture(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    ...options,
  });
}

export function applyUpdaterSigningEnv(root, env = process.env) {
  if (env.TAURI_SIGNING_PRIVATE_KEY && env.TAURI_SIGNING_PRIVATE_KEY.trim()) {
    return { applied: true, source: "env" };
  }
  const keyPath = join(root, UPDATER_KEY_REL);
  if (!existsSync(keyPath)) {
    return { applied: false, source: null };
  }
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD == null) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  }
  return { applied: true, source: keyPath };
}

/**
 * Re-sign the final Windows installer for the Tauri updater.
 *
 * Authenticode changes the PE bytes, so the minisign produced by
 * `tauri build` is no longer valid after the installer is code-signed.
 * Keep this operation in one helper so local packaging and SignPath use the
 * same final-byte signing rule.
 */
export function signUpdaterBundle(installerPath, root, run = spawnSync) {
  if (!existsSync(installerPath)) {
    throw new Error(`cannot sign missing updater installer: ${installerPath}`);
  }
  const tauriCli = join(root, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js");
  if (!existsSync(tauriCli)) {
    throw new Error("local Tauri CLI is missing; run pnpm install --frozen-lockfile");
  }

  // `tauri signer sign` accepts a literal key path more reliably than the
  // environment variable form across CLI versions. Prefer the gitignored
  // local key; in CI, materialize the secret only for the child process.
  const configuredKeyPath = join(root, UPDATER_KEY_REL);
  let temporaryKeyDir = null;
  let keyPath = configuredKeyPath;
  if (!existsSync(keyPath)) {
    const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
    if (privateKey) {
      temporaryKeyDir = mkdtempSync(join(tmpdir(), "pideck-updater-key-"));
      keyPath = join(temporaryKeyDir, "key");
      writeFileSync(keyPath, privateKey, { encoding: "utf8", mode: 0o600 });
    }
  }
  if (!existsSync(keyPath)) {
    throw new Error("Tauri updater private key is missing");
  }

  try {
    const signerArgs = [tauriCli, "signer", "sign", "--private-key-path", keyPath];
    if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined) {
      // Passing an empty value explicitly prevents the CLI from opening an
      // interactive password prompt for a key intentionally configured with
      // an empty password.
      signerArgs.push("--password", process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
    }
    signerArgs.push(installerPath);
    const result = run(process.execPath, signerArgs, {
      cwd: join(root, "apps/desktop"),
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error(`tauri signer sign failed for ${installerPath}`);
    }
  } finally {
    if (temporaryKeyDir) rmSync(temporaryKeyDir, { recursive: true, force: true });
  }

  const signaturePath = `${installerPath}.sig`;
  if (!existsSync(signaturePath) || readFileSync(signaturePath, "utf8").trim() === "") {
    throw new Error(`updater signature missing after signing: ${signaturePath}`);
  }
  return signaturePath;
}

function findSignTool() {
  const where = spawnCapture("where.exe", ["signtool"]);
  if (where.status === 0) {
    const first = (where.stdout || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith("signtool.exe"));
    if (first && existsSync(first)) return first;
  }
  const kits = join("C:\\Program Files (x86)\\Windows Kits\\10\\bin");
  if (!existsSync(kits)) return null;
  const versions = readdirSync(kits)
    .filter((name) => /^\d+\.\d+\.\d+\.\d+$/u.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = join(kits, version, "x64", "signtool.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readThumbprint(output, errorMessage) {
  const thumbprint = (output || "").trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!thumbprint || !/^[0-9A-Fa-f]{40}$/u.test(thumbprint)) {
    throw new Error(errorMessage);
  }
  return thumbprint;
}

function importWindowsPfx(certificateBase64, password) {
  const script = [
    `$pfxPath = Join-Path $env:TEMP ("papermatrix-codesign-" + [guid]::NewGuid().ToString() + ".pfx")`,
    `try {`,
    `  [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String(${JSON.stringify(certificateBase64)}))`,
    `  $secure = ConvertTo-SecureString ${JSON.stringify(password ?? "")} -AsPlainText -Force`,
    `  $cert = Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation Cert:\\CurrentUser\\My -Password $secure -Exportable`,
    `  if (-not $cert -or -not $cert.HasPrivateKey) { throw 'PFX import did not yield a private key' }`,
    `  $cert.Thumbprint`,
    `} finally {`,
    `  if (Test-Path $pfxPath) { Remove-Item -Force $pfxPath }`,
    `}`,
  ].join("; ");
  const result = spawnCapture("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `Could not import WINDOWS_CERTIFICATE PFX: ${(
        result.stderr ||
        result.stdout ||
        `exit ${result.status}`
      ).trim()}`,
    );
  }
  const thumbprint = readThumbprint(
    result.stdout,
    `WINDOWS_CERTIFICATE PFX import did not return a thumbprint: ${(
      result.stderr ||
      result.stdout ||
      ""
    ).trim()}`,
  );
  return { thumbprint, created: false, subject: thumbprint, kind: "pfx" };
}

export function ensureWindowsCodeSigningCert() {
  const fromEnv = process.env.PIDECK_WINDOWS_CERT_THUMBPRINT?.trim();
  if (fromEnv) {
    if (!/^[0-9A-Fa-f]{40}$/u.test(fromEnv)) {
      throw new Error("PIDECK_WINDOWS_CERT_THUMBPRINT must be a 40-character SHA-1 thumbprint");
    }
    return { thumbprint: fromEnv, created: false, subject: fromEnv, kind: "provided" };
  }
  const certificate = process.env.WINDOWS_CERTIFICATE?.trim();
  const password = process.env.WINDOWS_CERTIFICATE_PASSWORD;
  if (certificate || (typeof password === "string" && password.length > 0)) {
    if (!certificate || password == null) {
      throw new Error(
        "WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must be configured together",
      );
    }
    return importWindowsPfx(certificate, password);
  }
  const script = [
    `$existing = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object {`,
    `  $_.HasPrivateKey -and $_.Subject -eq '${DEV_CERT_SUBJECT}' -and $_.NotAfter -gt (Get-Date)`,
    `} | Sort-Object NotAfter -Descending | Select-Object -First 1`,
    `if (-not $existing) {`,
    `  $existing = New-SelfSignedCertificate -Type CodeSigningCert -Subject '${DEV_CERT_SUBJECT}' -HashAlgorithm SHA256 -KeyAlgorithm RSA -KeyLength 2048 -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(5)`,
    `}`,
    `$existing.Thumbprint`,
  ].join("; ");
  const result = spawnCapture("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `Could not create or find a PaperMatrix code-signing certificate: ${
        result.stderr || result.stdout || `exit ${result.status}`
      }`,
    );
  }
  const thumbprint = readThumbprint(
    result.stdout,
    `Could not create or find a PaperMatrix code-signing certificate: ${
      result.stderr || result.stdout || `exit ${result.status}`
    }`,
  );
  return { thumbprint, created: true, subject: DEV_CERT_SUBJECT, kind: "self-signed" };
}

export function signWindowsPe(filePath, thumbprint) {
  if (!existsSync(filePath)) throw new Error(`cannot sign missing file: ${filePath}`);
  const signtool = findSignTool();
  if (!signtool) throw new Error("signtool.exe not found; install the Windows 10/11 SDK");
  const timestampUrls = [
    process.env.PIDECK_WINDOWS_TIMESTAMP_URL,
    "http://timestamp.digicert.com",
    "http://timestamp.sectigo.com",
  ].filter((url) => typeof url === "string" && url.length > 0);
  for (const url of timestampUrls) {
    const signed = spawnCapture(signtool, [
      "sign",
      "/fd",
      "SHA256",
      "/td",
      "SHA256",
      "/tr",
      url,
      "/sha1",
      thumbprint,
      filePath,
    ]);
    if (signed.status === 0) {
      return { ok: true, timestampUrl: url, signtool, thumbprint };
    }
    console.warn(
      `[sign] timestamp ${url} failed:`,
      (signed.stderr || signed.stdout || "").trim().slice(0, 400),
    );
  }
  const unsignedTs = spawnCapture(signtool, [
    "sign",
    "/fd",
    "SHA256",
    "/sha1",
    thumbprint,
    filePath,
  ]);
  if (unsignedTs.status !== 0) {
    throw new Error(
      `signtool failed: ${(unsignedTs.stderr || unsignedTs.stdout || "").trim() || unsignedTs.status}`,
    );
  }
  return { ok: true, timestampUrl: null, signtool, thumbprint };
}

export function verifyWindowsPe(filePath) {
  const script = [
    `$sig = Get-AuthenticodeSignature -FilePath ${JSON.stringify(filePath)}`,
    `Write-Output ("STATUS=" + $sig.Status)`,
    `Write-Output ("THUMBPRINT=" + $sig.SignerCertificate.Thumbprint)`,
    `Write-Output ("SUBJECT=" + $sig.SignerCertificate.Subject)`,
  ].join("; ");
  const result = spawnCapture("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const status = output.match(/^STATUS=(.+)$/m)?.[1]?.trim() ?? "";
  const thumbprint = output.match(/^THUMBPRINT=(.+)$/m)?.[1]?.trim() ?? "";
  const trusted = status === "Valid";
  const signed = Boolean(thumbprint) && status !== "NotSigned" && status !== "HashMismatch";
  return { ok: signed, trusted, status, thumbprint, output };
}
