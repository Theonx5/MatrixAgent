/** Derive a semver from a git tag like v1.2.0 or agent-v1.2.0. */
export function releaseVersionFromTag(tag) {
  const match = String(tag ?? "").match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export function releaseVersionFromEnv(env = process.env) {
  const explicit = env.PIDECK_RELEASE_VERSION?.trim();
  if (explicit && /^\d+\.\d+\.\d+$/u.test(explicit)) return explicit;
  return releaseVersionFromTag(env.RELEASE_TAG || env.GITHUB_REF_NAME || "");
}

export function tauriVersionCliArgs(version) {
  if (!version) return [];
  return ["--config", JSON.stringify({ version })];
}
