import { describe, expect, it } from "vitest";
import {
  PI_AGENT_DIR_ENV,
  resetSealedAgentDirForTests,
  resolveSealedAgentDir,
  sealPiEnvironment,
  sealedAgentDir,
} from "./env-sandbox.js";

function sealedEnv(): { env: Record<string, string | undefined>; agentDir: string } {
  const agentDir = "/tmp/matrix-agent-home/.MatrixAgent";
  const env: Record<string, string | undefined> = {
    // A Pi CLI shell environment leaks session identity, model picks and
    // redirection overrides — none of it may survive the seal.
    PI_SESSION_FILE: "C:/Users/me/.pi/agent/sessions/x.jsonl",
    PI_SESSION_ID: "01a065e6-e9e2-7694-9ad7-d6277990fa32",
    PI_PROVIDER: "packy-glm",
    PI_MODEL: "glm-5.3-flash",
    PI_REASONING_LEVEL: "high",
    PI_OFFLINE: "1",
    PI_PACKAGE_DIR: "/opt/pi/packages",
    PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
    PI_CODING_AGENT_DIR: "C:/Users/me/.pi/agent",
    // PiDeck's own namespace must survive the scrub.
    PIDECK_HOST_CACHE_DIR: "/tmp/pideck-cache",
    PIDECK_TEST_FAUX: undefined,
    PATH: "/usr/bin",
  };
  return { env, agentDir };
}

describe("sealPiEnvironment", () => {
  it("deletes every inherited PI_* variable and pins the isolated agent dir", () => {
    const { env, agentDir } = sealedEnv();
    const removed = sealPiEnvironment(agentDir, env);
    expect(env[PI_AGENT_DIR_ENV]).toBe(agentDir);
    expect(env.PIDECK_HOST_CACHE_DIR).toBe("/tmp/pideck-cache");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.PI_SESSION_ID).toBeUndefined();
    expect(env.PI_PROVIDER).toBeUndefined();
    expect(env.PI_MODEL).toBeUndefined();
    expect(env.PI_REASONING_LEVEL).toBeUndefined();
    expect(env.PI_OFFLINE).toBeUndefined();
    expect(env.PI_PACKAGE_DIR).toBeUndefined();
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(removed).toContain("PI_SESSION_FILE");
    expect(removed).toContain("PI_OFFLINE");
    expect(removed).not.toContain("PIDECK_HOST_CACHE_DIR");
  });

  it("is case-insensitive on the PI_ prefix but keeps PIDECK_*", () => {
    const env: Record<string, string | undefined> = {
      pi_offline: "1",
      Pi_Session_File: "/tmp/x.jsonl",
      PIDECK_HOST_CACHE_DIR: "/tmp/pideck-cache",
    };
    const removed = sealPiEnvironment("/tmp/agent", env);
    expect(env.pi_offline).toBeUndefined();
    expect(env.Pi_Session_File).toBeUndefined();
    expect(env.PIDECK_HOST_CACHE_DIR).toBe("/tmp/pideck-cache");
    expect(env[PI_AGENT_DIR_ENV]).toBe("/tmp/agent");
    expect(removed).toContain("pi_offline");
  });

  it("is idempotent — resealing keeps the pinned dir and removes nothing new", () => {
    const { env, agentDir } = sealedEnv();
    sealPiEnvironment(agentDir, env);
    const secondPass = sealPiEnvironment(agentDir, env);
    expect(secondPass).toEqual([]);
    expect(env[PI_AGENT_DIR_ENV]).toBe(agentDir);
  });
});

describe("resolveSealedAgentDir", () => {
  it("prefers the CLI arg over the inherited env dir", () => {
    const agentDir = resolveSealedAgentDir(["node", "main.js", "--agent-dir=/tmp/chosen"], {
      [PI_AGENT_DIR_ENV]: "/tmp/injected",
    });
    expect(agentDir).toBe("/tmp/chosen");
  });

  it("falls back to the injected env dir when no arg is present", () => {
    const agentDir = resolveSealedAgentDir(["node", "main.js"], {
      [PI_AGENT_DIR_ENV]: "/tmp/injected",
    });
    expect(agentDir).toBe("/tmp/injected");
  });

  it("rejects an external Pi CLI dir in the arg position", () => {
    const agentDir = resolveSealedAgentDir(
      ["node", "main.js", "--agent-dir=C:/Users/me/.pi/agent"],
      {},
    );
    expect(agentDir).not.toContain(".pi/agent");
  });

  it("rejects an external Pi CLI dir in the env position", () => {
    const agentDir = resolveSealedAgentDir(["node", "main.js"], {
      [PI_AGENT_DIR_ENV]: "C:/Users/me/.pi/agent",
    });
    expect(agentDir).not.toContain(".pi/agent");
  });

  it("defaults to ~/.MatrixAgent when nothing is provided", () => {
    const agentDir = resolveSealedAgentDir(["node", "main.js"], {});
    expect(agentDir.replace(/\\/gu, "/")).toMatch(/\.MatrixAgent$/u);
  });
});

describe("sealedAgentDir", () => {
  it("resolves, seals, memoizes, and re-pins after env tampering", () => {
    resetSealedAgentDirForTests();
    const previousArgv = process.argv;
    const previousEnv = process.env[PI_AGENT_DIR_ENV];
    try {
      process.argv = ["node", "main.js", "--agent-dir=/tmp/sealed-agent"];
      expect(sealedAgentDir()).toBe("/tmp/sealed-agent");
      expect(process.env[PI_AGENT_DIR_ENV]).toBe("/tmp/sealed-agent");
      // Memoized: later calls return the same dir even if argv changes.
      process.argv = ["node", "main.js"];
      expect(sealedAgentDir()).toBe("/tmp/sealed-agent");
      // Re-pin: external rewrites of the env var cannot desync the seal.
      process.env[PI_AGENT_DIR_ENV] = "C:/Users/me/.pi/agent";
      expect(sealedAgentDir()).toBe("/tmp/sealed-agent");
      expect(process.env[PI_AGENT_DIR_ENV]).toBe("/tmp/sealed-agent");
    } finally {
      process.argv = previousArgv;
      if (previousEnv === undefined) delete process.env[PI_AGENT_DIR_ENV];
      else process.env[PI_AGENT_DIR_ENV] = previousEnv;
      resetSealedAgentDirForTests();
    }
  });
});
