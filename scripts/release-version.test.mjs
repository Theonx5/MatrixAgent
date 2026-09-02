import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseVersionFromEnv,
  releaseVersionFromTag,
  tauriVersionCliArgs,
} from "./release-version.mjs";

test("parses v and agent-v tags", () => {
  assert.equal(releaseVersionFromTag("v1.2.0"), "1.2.0");
  assert.equal(releaseVersionFromTag("agent-v1.3.0"), "1.3.0");
  assert.equal(releaseVersionFromTag("main"), null);
});

test("prefers PIDECK_RELEASE_VERSION over the tag", () => {
  assert.equal(
    releaseVersionFromEnv({ PIDECK_RELEASE_VERSION: "2.0.0", RELEASE_TAG: "v1.0.0" }),
    "2.0.0",
  );
  assert.equal(releaseVersionFromEnv({ GITHUB_REF_NAME: "agent-v0.9.1" }), "0.9.1");
});

test("passes Tauri --config version without dirtying the tree", () => {
  assert.deepEqual(tauriVersionCliArgs("1.2.0"), ["--config", '{"version":"1.2.0"}']);
  assert.deepEqual(tauriVersionCliArgs(null), []);
});
