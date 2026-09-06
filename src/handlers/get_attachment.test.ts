/**
 * get_attachment handler tests (CP-2715 batch 4 — shape slim).
 *
 * Coverage:
 *   - Happy path: metadata fetch + binary download → returns new compact
 *     shape (summary removed, request.saveToPath echo removed, top-level
 *     path/size/mimeType/filename preserved).
 *   - Default save path derivation: when saveToPath is undefined → falls
 *     back to /tmp/openclaw-attachments/{id}.{ext}, mkdir called.
 *   - Custom saveToPath: passed through verbatim; mkdir NOT called.
 *   - details <100-char one-line summary.
 *   - Validation: missing attachmentId, wrong-type saveToPath.
 *   - Error paths (CP-2715 红线: shape preserved):
 *       - metadata HTTP error → {error: "jira.get_attachment (metadata) failed: ..."}
 *       - mkdir failure (default path only) → {error: "failed to create ..."}
 *       - binary download non-2xx → {error: "jira.get_attachment download failed: HTTP ..."}
 *       - binary download thrown → {error: "jira.get_attachment download failed: ..."}
 *
 * Strategy: mock `node:fs/promises` for mkdir/writeFile (deterministic,
 * no actual disk I/O), mock `auth.js` for loadConfig (same pattern as
 * other handler tests), mock jiraGet for metadata, mock global fetch
 * for binary download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../http.js", () => ({
  jiraGet: vi.fn(),
  jiraPost: vi.fn(),
  jiraPut: vi.fn(),
  JiraHttpError: class extends Error {
    constructor(public status: number, public statusText: string, public body: string) {
      super(`HTTP ${status} ${statusText}`);
    }
  },
  buildUrl: (cfg: { cloudId: string }, path: string) =>
    `https://api.atlassian.com/ex/jira/${cfg.cloudId}/rest/api/3/${path}`,
  authHeaders: (cfg: { atstToken: string }) => ({
    Authorization: `Bearer ${cfg.atstToken}`,
    Accept: "application/json",
  }),
}));

vi.mock("../auth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({
      atstToken: "test-token",
      cloudId: "test-cloud",
      proxy: "",
      defaultAssigneeAccountId: "",
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

import { jiraGet, JiraHttpError } from "../http.js";
import * as fsPromises from "node:fs/promises";
import { getAttachment } from "../handlers/get_attachment.js";

const META = {
  id: "12345",
  filename: "hello.txt",
  size: 11,
  mimeType: "text/plain",
  content: "https://api.atlassian.com/.../att-100",
};

describe("get_attachment (CP-2715 batch 4)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(fsPromises.mkdir).mockReset();
    vi.mocked(fsPromises.writeFile).mockReset();
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined as never);

    // metadata first, then binary download via raw fetch
    vi.mocked(jiraGet).mockResolvedValue(META);

    fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from("hello world"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("AC-2715-GA-1: happy path — new shape (summary removed, request.saveToPath echo removed)", async () => {
    const result = await getAttachment({
      attachmentId: "12345",
      saveToPath: "/tmp/custom/hello.txt",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("get_attachment");

    // CP-2715 batch 4: request 锚仅 attachmentId (saveToPath 回声去除)
    expect(parsed.request).toEqual({ attachmentId: "12345" });
    expect(parsed.request).not.toHaveProperty("saveToPath");

    // CP-2715 batch 4: top-level 5 字段保留
    expect(parsed.path).toBe("/tmp/custom/hello.txt");
    expect(parsed.size).toBe(11);
    expect(parsed.mimeType).toBe("text/plain");
    expect(parsed.filename).toBe("hello.txt");

    // CP-2715 batch 4: summary 块去除 (5 字段全部与顶层重复)
    expect(parsed).not.toHaveProperty("summary");

    // details <100 字符
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/附件 12345 \(hello\.txt\) 已下载, 11 字节/);
  });

  it("AC-2715-GA-2: default save path derives from mimeType + mkdir called", async () => {
    const result = await getAttachment({ attachmentId: "12345" });
    const parsed = JSON.parse(result.content[0].text as string);

    // 默认路径: /tmp/openclaw-attachments/{id}.{ext} (ext 来自 mimeType)
    expect(parsed.path).toBe("/tmp/openclaw-attachments/12345.txt");
    // 自定义路径未传 → mkdir 应被调用一次
    expect(vi.mocked(fsPromises.mkdir)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fsPromises.mkdir)).toHaveBeenCalledWith(
      "/tmp/openclaw-attachments",
      { recursive: true },
    );
    // writeFile 落到默认路径
    expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
      "/tmp/openclaw-attachments/12345.txt",
      expect.any(Buffer),
    );
  });

  it("AC-2715-GA-3: custom saveToPath → path verbatim; mkdir NOT called (caller's dir)", async () => {
    const customPath = "/var/lib/myapp/incoming/evidence.png";
    const META_PNG = { ...META, filename: "evidence.png", mimeType: "image/png" };
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraGet).mockResolvedValueOnce(META_PNG);

    const result = await getAttachment({
      attachmentId: "12345",
      saveToPath: customPath,
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.path).toBe(customPath);
    expect(parsed.filename).toBe("evidence.png");
    expect(parsed.mimeType).toBe("image/png");
    // 自定义路径时不 mkdir (caller 责任)
    expect(vi.mocked(fsPromises.mkdir)).not.toHaveBeenCalled();
    expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
      customPath,
      expect.any(Buffer),
    );
    // details <100
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2715-GA-4: validation — missing attachmentId → error + slim details", async () => {
    const result = await getAttachment({});
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.error).toMatch(/attachmentId/);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/缺少 attachmentId/);
  });

  it("AC-2715-GA-5: validation — non-string saveToPath → error + slim details", async () => {
    const result = await getAttachment({
      attachmentId: "12345",
      saveToPath: 123,
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.error).toMatch(/saveToPath/);
    expect(parsed.error).toMatch(/must be a string/);
    expect(jiraGet).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/saveToPath 非法/);
  });

  it("AC-2715-GA-6: metadata HTTP 404 → error envelope preserved + slim details", async () => {
    vi.mocked(jiraGet).mockReset();
    vi.mocked(jiraGet).mockRejectedValueOnce(
      new JiraHttpError(404, "Not Found", "no such attachment"),
    );
    const result = await getAttachment({ attachmentId: "99999" });
    const parsed = JSON.parse(result.content[0].text as string);

    // CP-2715 红线: 错误路径文案逐字保留
    expect(parsed.error).toMatch(/metadata.*failed/);
    expect(parsed.error).toMatch(/HTTP 404/);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/HTTP 404/);
  });

  it("AC-2715-GA-7: mkdir failure (default path) → error envelope preserved + slim details", async () => {
    vi.mocked(fsPromises.mkdir).mockReset();
    vi.mocked(fsPromises.mkdir).mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );
    const result = await getAttachment({ attachmentId: "12345" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.error).toMatch(/failed to create/);
    expect(parsed.error).toMatch(/EACCES/);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/创建 \/tmp\/openclaw-attachments 失败/);
  });

  it("AC-2715-GA-8: binary download HTTP 500 → error envelope preserved + slim details", async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response("kaboom", { status: 500, statusText: "Server Error" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAttachment({ attachmentId: "12345" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.error).toMatch(/download failed/);
    expect(parsed.error).toMatch(/HTTP 500/);
    expect(vi.mocked(fsPromises.writeFile)).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/HTTP 500/);
  });

  it("AC-2715-GA-9: binary fetch throws → error envelope preserved + slim details", async () => {
    fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAttachment({ attachmentId: "12345" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.error).toMatch(/download failed/);
    expect(parsed.error).toMatch(/ECONNRESET/);

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/ECONNRESET/);
  });
});
