/**
 * upload_attachment handler tests (CP-2715 batch 4 — shape slim).
 *
 * Coverage:
 *   - Happy path: real file → POST hits Atlassian attachments endpoint with
 *     the right URL, auth headers (Bearer + X-Atlassian-Token: no-check),
 *     multipart body, and returns the new compact shape.
 *   - Compact pick (v0.5 §6): mocked Atlassian response includes extra
 *     fields (author / created / self / _links / thumbnail) — handler must
 *     return ONLY {id, filename, size, mimeType, content} per item, no leak.
 *   - count field: derived from attachments.length.
 *   - request echo trim: request has only issueIdOrKey; no filePath / size /
 *     filename echo.
 *   - summary block REMOVED.
 *   - details <100-char one-line summary.
 *   - Validation: missing issueIdOrKey, missing filePath.
 *   - file not found: fs.stat throws ENOENT → ok:false with status 404.
 *   - file too large: file > 100 MB → ok:false with status 413, no HTTP call.
 *   - Upstream error: non-2xx from Jira surfaces as ok:false with the
 *     server's status code (preserved contract).
 *
 * Strategy: mock `node:fs/promises` for stat/readFile (deterministic, no
 * need to write a 100MB file to disk), mock `auth.js` for loadConfig
 * (same pattern as the other handler tests), and mock global fetch to
 * capture the actual outbound request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
  },
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../auth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({
      atstToken: "test-token-abc",
      cloudId: "test-cloud-123",
      proxy: "",
      defaultAssigneeAccountId: "",
    }),
  };
});

import * as fsPromises from "node:fs/promises";
import { uploadAttachment } from "../handlers/upload_attachment.js";

const fakeFileStat = (size: number) => ({
  size,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  mtime: new Date(0),
  birthtime: new Date(0),
  atime: new Date(0),
  ctime: new Date(0),
  ino: 0,
  mode: 0,
  uid: 0,
  gid: 0,
  dev: 0,
  rdev: 0,
  blksize: 0,
  blocks: 0,
  nlink: 0,
});

/**
 * Mocked Atlassian attachment response — INCLUDES raw extra fields
 * (author / created / self / thumbnail / _links) that must NOT leak into
 * the returned compact shape (v0.5 §6 — explicit 5-field pick).
 */
const atlassianUploadResponse = [
  {
    id: "att-100",
    self: "https://api.atlassian.com/ex/jira/test-cloud-123/rest/api/3/attachment/100",
    filename: "hello.txt",
    author: {
      self: "https://api.atlassian.com/user?accountId=u1",
      accountId: "u1",
      displayName: "Test User",
      active: true,
      timeZone: "UTC",
      accountType: "atlassian",
    },
    size: 11,
    mimeType: "text/plain",
    content: "https://api.atlassian.com/.../att-100",
    thumbnail: "https://api.atlassian.com/.../att-100/thumb",
    created: "2026-09-06T10:00:00.000+0000",
    _links: {
      self: "https://api.atlassian.com/.../att-100",
      download: "https://api.atlassian.com/.../att-100/content",
      thumbnail: "https://api.atlassian.com/.../att-100/thumb",
    },
    metadata: { someExtra: "should-not-leak" },
  },
];

describe("upload_attachment (CP-2715 batch 4)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(fsPromises.stat).mockReset();
    vi.mocked(fsPromises.readFile).mockReset();
    vi.mocked(fsPromises.stat).mockResolvedValue(fakeFileStat(1024) as never);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("hello world") as never);

    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(atlassianUploadResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("AC-2715-UA-1: happy path — new compact shape (summary removed, request echo trimmed, attachments compact 5 fields)", async () => {
    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/upload.txt",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe("upload_attachment");

    // CP-2715 batch 4: request 锚仅 issueIdOrKey (filePath/size/filename 回声去除)
    expect(parsed.request).toEqual({ issueIdOrKey: "SSSS-454" });
    expect(parsed.request).not.toHaveProperty("filePath");
    expect(parsed.request).not.toHaveProperty("size");
    expect(parsed.request).not.toHaveProperty("filename");

    // CP-2715 batch 4: count 派生字段 = attachments.length
    expect(parsed.count).toBe(1);

    // CP-2715 batch 4: attachments 显式 pick 5 字段 (id/filename/size/mimeType/content)
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toEqual({
      id: "att-100",
      filename: "hello.txt",
      size: 11,
      mimeType: "text/plain",
      content: "https://api.atlassian.com/.../att-100",
    });
    // 反断言: raw Atlassian 字段 0 混入
    expect(parsed.attachments[0]).not.toHaveProperty("author");
    expect(parsed.attachments[0]).not.toHaveProperty("created");
    expect(parsed.attachments[0]).not.toHaveProperty("self");
    expect(parsed.attachments[0]).not.toHaveProperty("thumbnail");
    expect(parsed.attachments[0]).not.toHaveProperty("_links");
    expect(parsed.attachments[0]).not.toHaveProperty("metadata");

    // CP-2715 batch 4: summary 块去除
    expect(parsed).not.toHaveProperty("summary");

    // details <100 字符一句话摘要
    expect(typeof result.details).toBe("string");
    const details = result.details as string;
    expect(details.length).toBeLessThan(100);
    expect(details).toMatch(/已上传 upload\.txt \(\d+ 字节\) 至 SSSS-454/);
  });

  it("AC-2715-UA-2: request URL is /issue/{key}/attachments under atlassian cloud base", async () => {
    await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/upload.txt",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      "https://api.atlassian.com/ex/jira/test-cloud-123/rest/api/3/issue/SSSS-454/attachments",
    );
    expect(init.method).toBe("POST");
  });

  it("AC-2715-UA-3: auth headers — Bearer token + X-Atlassian-Token: no-check + Accept json", async () => {
    await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/upload.txt",
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-abc");
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("AC-2715-UA-4: body is FormData with one 'file' part", async () => {
    await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/upload.txt",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("AC-2715-UA-5: file not found → ok:false with status 404, no HTTP call", async () => {
    const enoent: NodeJS.ErrnoException = new Error("ENOENT: no such file");
    enoent.code = "ENOENT";
    vi.mocked(fsPromises.stat).mockRejectedValueOnce(enoent);

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/does-not-exist.txt",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    // 既有契约: {ok:false, error:{status,message}} 完整保留 (CP-2715 红线)
    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(404);
    expect(parsed.error.message).toMatch(/file not found/);
    expect(parsed.error.message).toContain("/tmp/does-not-exist.txt");
    expect(fetchMock).not.toHaveBeenCalled();

    // details <100 字符
    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/文件不存在/);
  });

  it("AC-2715-UA-6: file too large (101 MB) → ok:false with status 413, no HTTP call", async () => {
    const oversize = 101 * 1024 * 1024;
    vi.mocked(fsPromises.stat).mockResolvedValueOnce(fakeFileStat(oversize) as never);

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/huge.bin",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(413);
    expect(parsed.error.message).toMatch(/file too large/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fsPromises.readFile).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/超 100MB/);
  });

  it("AC-2715-UA-7: rejects missing issueIdOrKey", async () => {
    const result = await uploadAttachment({ filePath: "/tmp/upload.txt" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.message).toMatch(/issueIdOrKey/);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2715-UA-8: rejects missing filePath", async () => {
    const result = await uploadAttachment({ issueIdOrKey: "SSSS-454" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.message).toMatch(/filePath/);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC-2715-UA-9: upstream 401 surfaces as ok:false with status 401", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/upload.txt",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(401);
    expect(parsed.error.message).toMatch(/HTTP 401/);

    expect(typeof result.details).toBe("string");
    expect((result.details as string).length).toBeLessThan(100);
    expect(result.details as string).toMatch(/HTTP 401/);
  });

  it("AC-2715-UA-10: filename in details is basename of filePath", async () => {
    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/var/data/screenshots/2026-07-01.png",
    });
    // details 引用 basename(filePath) 而非 summary.filename
    expect(result.details as string).toMatch(/2026-07-01\.png/);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed).not.toHaveProperty("summary");
  });

  it("AC-2715-UA-11: long filePath (large echo) → details <100 chars; full path NOT echoed in content", async () => {
    const longPath =
      "/var/data/screenshots/2026-09-06/project-x/very/deep/subdir/screenshot-v3-final-evidence.png";
    const result = await uploadAttachment({
      issueIdOrKey: "WTO-1234",
      filePath: longPath,
    });
    const parsed = JSON.parse(result.content[0].text as string);

    // full path 不应回显到 request 字段
    expect(JSON.stringify(parsed.request)).not.toContain(longPath);
    // summary 不存在
    expect(parsed).not.toHaveProperty("summary");
    // details <100 字符
    expect((result.details as string).length).toBeLessThan(100);
    // details 仅 basename
    expect(result.details as string).toContain("screenshot-v3-final-evidence.png");
    expect(result.details as string).not.toContain("/var/data/screenshots");
    expect(result.details as string).toMatch(/WTO-1234/);
  });
});
