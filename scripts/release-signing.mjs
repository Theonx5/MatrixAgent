/**
 * Release signing helpers:
 * - Tauri updater minisign private key (TAURI_SIGNING_PRIVATE_KEY)
 * - Windows Authenticode via signtool + a local or provided certificate
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

export function ensureWindowsCodeSigningCert() {
  const fromEnv = process.env.PIDECK_WINDOWS_CERT_THUMBPRINT?.trim();
  if (fromEnv) return { thumbprint: fromEnv, created: false, subject: fromEnv };
  const script = [
    `$existing = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object {`,
    `  $_.HasPrivateKey -and $_.Subject -eq '${DEV_CERT_SUBJECT}' -and $_.NotAfter -gt (Get-Date)`,
    `} | Sort-Object NotAfter -Descending | Select-Object -First 1`,
    `if (-not $existing) {`,
    `  $existing = New-SelfSignedCertificate -Type CodeSigningCert -Subject '${DEV_CERT_SUBJECT}' -HashAlgorithm SHA256 -KeyAlgorithm RSA -KeyLength 2048 -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(5)`,
    `}`,
    `$existing.Thumbprint`,
  ].join("; ");
  const result = spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const thumbprint = (result.stdout || "").trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (result.status !== 0 || !thumbprint || !/^[0-9A-Fa-f]{40}$/u.test(thumbprint)) {
    throw new Error(
      `Could not create or find a PaperMatrix code-signing certificate: ${
        result.stderr || result.stdout || `exit ${result.status}`
      }`,
    );
  }
  return { thumbprint, created: true, subject: DEV_CERT_SUBJECT };
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
  const unsignedTs = spawnCapture(signtool, ["sign", "/fd", "SHA256", "/sha1", thumbprint, filePath]);
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
  const result = spawnCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const status = output.match(/^STATUS=(.+)$/m)?.[1]?.trim() ?? "";
  const thumbprint = output.match(/^THUMBPRINT=(.+)$/m)?.[1]?.trim() ?? "";
  const trusted = status === "Valid";
  const signed =
    Boolean(thumbprint) && status !== "NotSigned" && status !== "HashMismatch";
  return { ok: signed, trusted, status, thumbprint, output };
}

