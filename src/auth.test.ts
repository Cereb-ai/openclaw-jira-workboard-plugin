/**
 * auth.ts tests — CP-2955 env-first credential resolution.
 *
 * Resolution order (token: JIRA_ATST_TOKEN > ATST_TOKEN; cloudId: JIRA_CLOUD_ID):
 *   1. explicit cfg.<field> (per-call arg)
 *   2. process.env (JIRA_ATST_TOKEN > ATST_TOKEN for token; JIRA_CLOUD_ID; etc.)
 *   3. openclaw.json plugins.entries.jira-openclaw-plugin.config.<field>
 *
 * AC1: covers all four layers incl. two aliases; env wins over openclaw.json.
 * AC3: error message no longer mentions ~/.config/environment.d/jira.conf or
 *      ~/.bashrc; points at env names instead.
 *
 * Each test resets process.env + sets a temp HOME so the openclaw.json
 * fallback is fully isolated. setPluginConfig(null) is called between tests
 * so module state doesn't leak.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadConfig,
  setPluginConfig,
  JiraAuthError,
} from "./auth.js";

// Capture the env vars this module reads so we can save/restore around tests.
const ENV_VARS = [
  "JIRA_ATST_TOKEN",
  "ATST_TOKEN",
  "JIRA_CLOUD_ID",
  "JIRA_PROXY",
  "JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID",
  "HOME",
  "USERPROFILE",
];

function clearEnv(): void {
  for (const v of ENV_VARS) delete process.env[v];
}

function makeOpenclawJson(dir: string, config: Record<string, unknown>): void {
  const homeDir = path.join(dir, ".openclaw");
  fs.mkdirSync(homeDir, { recursive: true });
  const payload = {
    plugins: { entries: { "jira-openclaw-plugin": { config } } },
  };
  fs.writeFileSync(path.join(homeDir, "openclaw.json"), JSON.stringify(payload));
}

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const v of ENV_VARS) savedEnv[v] = process.env[v];
  clearEnv();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-auth-test-"));
  process.env.HOME = tmpDir;
  setPluginConfig(null);
});

afterEach(() => {
  for (const v of ENV_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  setPluginConfig(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig — token resolution order (CP-2955 env-first)", () => {
  it("AC1: explicit cfg wins over everything", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    makeOpenclawJson(tmpDir, { atstToken: "file-token", cloudId: "file-cloud" });
    const cfg = loadConfig({ atstToken: "explicit-token" });
    expect(cfg.atstToken).toBe("explicit-token");
  });

  it("AC1: JIRA_ATST_TOKEN env wins over ATST_TOKEN legacy alias", () => {
    process.env.JIRA_ATST_TOKEN = "primary-token";
    process.env.ATST_TOKEN = "legacy-token";
    process.env.JIRA_CLOUD_ID = "cloud-1";
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("primary-token");
  });

  it("AC1: ATST_TOKEN legacy alias used when JIRA_ATST_TOKEN unset", () => {
    process.env.ATST_TOKEN = "legacy-token";
    process.env.JIRA_CLOUD_ID = "cloud-1";
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("legacy-token");
  });

  it("AC1: env wins over openclaw.json (env present → file ignored)", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    makeOpenclawJson(tmpDir, { atstToken: "file-token", cloudId: "file-cloud" });
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("env-token");
    expect(cfg.cloudId).toBe("env-cloud");
  });

  it("AC1: openclaw.json used as last-resort fallback when env empty", () => {
    makeOpenclawJson(tmpDir, { atstToken: "file-token", cloudId: "file-cloud" });
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("file-token");
    expect(cfg.cloudId).toBe("file-cloud");
  });

  it("AC1: empty HOME + only env → no file read, no error", () => {
    // Use a HOME that points at a non-existent dir to prove file-missing is
    // silently treated as empty (the env-only CLI path works).
    process.env.HOME = path.join(tmpDir, "does-not-exist");
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("env-token");
    expect(cfg.cloudId).toBe("env-cloud");
  });

  it("AC1: explicit cfg wins over env (and file)", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    makeOpenclawJson(tmpDir, { atstToken: "file-token", cloudId: "file-cloud" });
    const cfg = loadConfig({
      atstToken: "explicit-token",
      cloudId: "explicit-cloud",
    });
    expect(cfg.atstToken).toBe("explicit-token");
    expect(cfg.cloudId).toBe("explicit-cloud");
  });
});

describe("loadConfig — cloudId / proxy / defaultAssignee", () => {
  it("JIRA_CLOUD_ID env wins over openclaw.json", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    makeOpenclawJson(tmpDir, { cloudId: "file-cloud" });
    const cfg = loadConfig();
    expect(cfg.cloudId).toBe("env-cloud");
  });

  it("JIRA_PROXY: env → DEFAULT_PROXY(\"\") when env empty + file empty", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    const cfg = loadConfig();
    expect(cfg.proxy).toBe("");
  });

  it("JIRA_PROXY env propagates", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    process.env.JIRA_PROXY = "http://127.0.0.1:7890";
    const cfg = loadConfig();
    expect(cfg.proxy).toBe("http://127.0.0.1:7890");
  });

  it("JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID env propagates", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    process.env.JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID = "acct-123";
    const cfg = loadConfig();
    expect(cfg.defaultAssigneeAccountId).toBe("acct-123");
  });

  it("explicit proxy cfg wins over env", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    process.env.JIRA_PROXY = "http://from-env:7890";
    const cfg = loadConfig({ proxy: "http://from-cfg:7890" });
    expect(cfg.proxy).toBe("http://from-cfg:7890");
  });
});

describe("loadConfig — JiraAuthError (CP-2955 AC3)", () => {
  it("AC3: error names required env vars (no shell hint paths)", () => {
    // All env empty, no openclaw.json.
    expect(() => loadConfig()).toThrow(JiraAuthError);
    try {
      loadConfig();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("JIRA_ATST_TOKEN");
      expect(msg).toContain("JIRA_CLOUD_ID");
      // Old misleading hints — must NOT appear anymore.
      expect(msg).not.toContain("~/.config/environment.d/jira.conf");
      expect(msg).not.toContain("~/.bashrc");
      expect(msg).not.toContain("environment.d");
      // Actionable: tells the user how to set env.
      expect(msg).toMatch(/export JIRA_ATST_TOKEN/);
      expect(msg).toMatch(/export JIRA_CLOUD_ID/);
    }
  });

  it("AC3: only token missing → 'Missing required env var(s)' lists JIRA_ATST_TOKEN only", () => {
    process.env.JIRA_CLOUD_ID = "cloud-1";
    try {
      loadConfig();
      throw new Error("expected to throw");
    } catch (e) {
      const msg = (e as Error).message;
      // The "Missing required env var(s):" clause must list ONLY the missing
      // var, not the present one.
      const missingClause = msg.match(/Missing required env var\(s\): ([^.]+)\./);
      expect(missingClause).not.toBeNull();
      expect(missingClause![1]).toContain("JIRA_ATST_TOKEN");
      expect(missingClause![1]).not.toContain("JIRA_CLOUD_ID");
    }
  });

  it("AC3: only cloudId missing → 'Missing required env var(s)' lists JIRA_CLOUD_ID only", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    try {
      loadConfig();
      throw new Error("expected to throw");
    } catch (e) {
      const msg = (e as Error).message;
      const missingClause = msg.match(/Missing required env var\(s\): ([^.]+)\./);
      expect(missingClause).not.toBeNull();
      expect(missingClause![1]).toContain("JIRA_CLOUD_ID");
      expect(missingClause![1]).not.toContain("JIRA_ATST_TOKEN");
    }
  });

  it("AC3: missing openclaw.json is NOT an error when env is set", () => {
    process.env.HOME = path.join(tmpDir, "no-such-dir");
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    // No file write → silent fallback.
    expect(() => loadConfig()).not.toThrow();
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("env-token");
    expect(cfg.cloudId).toBe("env-cloud");
  });

  it("AC3: malformed openclaw.json is NOT an error (silently treated as empty)", () => {
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "openclaw.json"),
      "this is not valid json {{{",
    );
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    expect(() => loadConfig()).not.toThrow();
  });
});

describe("setPluginConfig — MCP-path env-first guarantee (CP-2955 AC: MCP 同样走 env)", () => {
  it("MCP path: env wins over setPluginConfig (gateway-bridged openclaw.json)", () => {
    // Simulate gateway having read openclaw.json and pushed it through
    // setPluginConfig. The new env must override.
    setPluginConfig({
      atstToken: "plugin-token",
      cloudId: "plugin-cloud",
      proxy: "",
      defaultAssigneeAccountId: "",
    });
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("env-token");
    expect(cfg.cloudId).toBe("env-cloud");
  });

  it("MCP path: explicit cfg still wins over env + pluginConfig", () => {
    setPluginConfig({
      atstToken: "plugin-token",
      cloudId: "plugin-cloud",
      proxy: "",
      defaultAssigneeAccountId: "",
    });
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    const cfg = loadConfig({ atstToken: "explicit-token" });
    expect(cfg.atstToken).toBe("explicit-token");
  });

  it("MCP path: setPluginConfig used as last-resort fallback when env empty", () => {
    setPluginConfig({
      atstToken: "plugin-token",
      cloudId: "plugin-cloud",
      proxy: "",
      defaultAssigneeAccountId: "",
    });
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("plugin-token");
    expect(cfg.cloudId).toBe("plugin-cloud");
  });
});

describe("loadConfig — empty string treated as unset", () => {
  it("empty JIRA_ATST_TOKEN falls through to ATST_TOKEN", () => {
    process.env.JIRA_ATST_TOKEN = "";
    process.env.ATST_TOKEN = "legacy-token";
    process.env.JIRA_CLOUD_ID = "cloud-1";
    const cfg = loadConfig();
    expect(cfg.atstToken).toBe("legacy-token");
  });

  it("empty explicit cfg.atstToken falls through to env", () => {
    process.env.JIRA_ATST_TOKEN = "env-token";
    process.env.JIRA_CLOUD_ID = "env-cloud";
    const cfg = loadConfig({ atstToken: "" });
    expect(cfg.atstToken).toBe("env-token");
  });
});