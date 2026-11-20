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

/**
 * CP-5107 — cross-sandbox byte sources (`url` / `base64`) + three-source
 * validation and actionable diagnostics.
 *
 * The gateway process can only read paths that exist on ITS filesystem, so an
 * artifact produced inside an e2e-runner Job / coder sandbox could never be
 * uploaded by passing `filePath`. These cases lock the two new entry points
 * (url = gateway-side fetch; base64 = caller-side encode), the mutual
 * exclusion rules, the 100MB cap applied to all three sources, the naming
 * rules, and the diagnostics that point at the new entries.
 */
const ATLASSIAN_UPLOAD_URL =
  "https://api.atlassian.com/ex/jira/test-cloud-123/rest/api/3/issue/SSSS-454/attachments";

function isUploadUrl(u: unknown): boolean {
  return String(u).startsWith("https://api.atlassian.com/");
}

function jsonUploadResponse(): Response {
  return new Response(JSON.stringify(atlassianUploadResponse), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The single POST to the Atlassian attachments endpoint (throws if absent). */
function uploadCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
  const call = fetchMock.mock.calls.find(([u]) => isUploadUrl(u)) as
    | [string, RequestInit]
    | undefined;
  if (!call) throw new Error("upload POST was not issued");
  return call;
}

/** Read back the multipart `file` part the handler built. */
async function uploadedFile(init: RequestInit): Promise<{ name: string; bytes: Buffer }> {
  const form = init.body as FormData;
  const file = form.get("file") as File;
  const bytes = Buffer.from(await file.arrayBuffer());
  return { name: file.name, bytes };
}

/** A chunked (no content-length) response body of exactly `totalBytes`. */
function chunkedResponse(totalBytes: number, chunkSize = 1024 * 1024): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
  return new Response(stream, { status: 200 });
}

describe("upload_attachment — CP-5107 cross-sandbox sources", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(fsPromises.stat).mockReset();
    vi.mocked(fsPromises.readFile).mockReset();
    vi.mocked(fsPromises.stat).mockResolvedValue(fakeFileStat(1024) as never);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("hello world") as never);

    fetchMock = vi.fn().mockResolvedValue(jsonUploadResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("AC1: url source — gateway downloads the bytes and uploads them (zero filesystem access)", async () => {
    const payload = Buffer.from("evidence-png-bytes");
    const signedUrl =
      "https://artifacts.example.com/runs/42/evidence.png?X-Goog-Signature=deadbeef";

    fetchMock.mockImplementation(async (u: unknown) => {
      if (isUploadUrl(u)) return jsonUploadResponse();
      expect(u).toBe(signedUrl);
      return new Response(payload, {
        status: 200,
        headers: { "content-length": String(payload.length) },
      });
    });

    const result = await uploadAttachment({ issueIdOrKey: "SSSS-454", url: signedUrl });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.attachments[0].id).toBe("att-100");
    // 反断言: 不需要文件出现在 gateway 文件系统
    expect(fsPromises.stat).not.toHaveBeenCalled();
    expect(fsPromises.readFile).not.toHaveBeenCalled();

    const [uploadUrlArg, init] = uploadCall(fetchMock);
    expect(uploadUrlArg).toBe(ATLASSIAN_UPLOAD_URL);
    expect(init.method).toBe("POST");

    // 上传的正是下载到的字节, 文件名 = URL path 的 basename (query 被丢弃)
    const file = await uploadedFile(init);
    expect(file.name).toBe("evidence.png");
    expect(file.bytes.equals(payload)).toBe(true);

    expect(result.details as string).toMatch(/已上传 evidence\.png \(18 字节\) 至 SSSS-454/);
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC4: url naming — percent-encoded path basename; explicit filename overrides", async () => {
    fetchMock.mockImplementation(async (u: unknown) =>
      isUploadUrl(u) ? jsonUploadResponse() : new Response("bytes", { status: 200 }),
    );

    const encodedUrl = "https://h.example.com/a/b/%E8%AF%81%E6%8D%AE.png";
    await uploadAttachment({ issueIdOrKey: "SSSS-454", url: encodedUrl });
    expect((await uploadedFile(uploadCall(fetchMock)[1])).name).toBe("证据.png");

    fetchMock.mockClear();
    fetchMock.mockImplementation(async (u: unknown) =>
      isUploadUrl(u) ? jsonUploadResponse() : new Response("bytes", { status: 200 }),
    );
    await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      url: encodedUrl,
      filename: "custom-name.png",
    });
    expect((await uploadedFile(uploadCall(fetchMock)[1])).name).toBe("custom-name.png");
  });

  it("AC2: base64 data URL + explicit filename → decoded bytes uploaded, no temp file", async () => {
    const raw = Buffer.from("hi there, base64");
    const b64 = raw.toString("base64");

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      base64: `data:image/png;base64,${b64}`,
      filename: "shot.png",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    // 反断言: 不先落盘再读
    expect(fsPromises.stat).not.toHaveBeenCalled();
    expect(fsPromises.readFile).not.toHaveBeenCalled();

    const file = await uploadedFile(uploadCall(fetchMock)[1]);
    expect(file.name).toBe("shot.png");
    expect(file.bytes.equals(raw)).toBe(true);
    expect(result.details as string).toMatch(/已上传 shot\.png \(16 字节\) 至 SSSS-454/);
  });

  it("AC2/AC4: plain base64 (newlines tolerated) uses the explicit filename verbatim", async () => {
    const raw = Buffer.from("line one\nline two\n");
    const b64 = raw.toString("base64").replace(/(.{8})/g, "$1\n");

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      base64: b64,
      filename: "notes with spaces.txt",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(true);
    const file = await uploadedFile(uploadCall(fetchMock)[1]);
    expect(file.name).toBe("notes with spaces.txt");
    expect(file.bytes.equals(raw)).toBe(true);
  });

  it("AC2: base64 without filename → 400 naming filename, zero HTTP calls", async () => {
    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      base64: Buffer.from("x").toString("base64"),
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.message).toMatch(/filename/);
    // 反断言: 不静默生成文件名
    expect(fetchMock).not.toHaveBeenCalled();
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC3: multiple sources → 400 'exactly one source', zero HTTP + zero fs access", async () => {
    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/a.png",
      url: "https://h.example.com/a.png",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.message).toMatch(/exactly one source/);
    expect(parsed.error.message).toContain("filePath");
    expect(parsed.error.message).toContain("url");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fsPromises.stat).not.toHaveBeenCalled();
  });

  it("AC3: no source → 400 listing filePath / url / base64", async () => {
    const result = await uploadAttachment({ issueIdOrKey: "SSSS-454" });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.message).toContain("filePath");
    expect(parsed.error.message).toContain("url");
    expect(parsed.error.message).toContain("base64");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC3: non-http(s) url scheme → 400, no download attempt", async () => {
    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      url: "ftp://files.example.com/a.png",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(400);
    expect(parsed.error.message).toMatch(/unsupported url scheme/);
    expect(parsed.error.message).toContain("ftp:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC4: url over 100MB (content-length) → 413 with the declared byte count, no upload", async () => {
    const oversize = 101 * 1024 * 1024;
    fetchMock.mockImplementation(async (u: unknown) => {
      if (isUploadUrl(u)) return jsonUploadResponse();
      return new Response("tiny", {
        status: 200,
        headers: { "content-length": String(oversize) },
      });
    });

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      url: "https://h.example.com/huge.bin",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(413);
    expect(parsed.error.message).toMatch(/file too large/);
    expect(parsed.error.message).toContain(String(oversize));
    expect(fetchMock.mock.calls.some(([u]) => isUploadUrl(u))).toBe(false);
  });

  it("AC4: url over 100MB (chunked, no content-length) → 413 on the actual downloaded bytes", async () => {
    const oversize = 101 * 1024 * 1024;
    fetchMock.mockImplementation(async (u: unknown) => {
      if (isUploadUrl(u)) return jsonUploadResponse();
      return chunkedResponse(oversize);
    });

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      url: "https://h.example.com/huge-chunked.bin",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(413);
    expect(parsed.error.message).toMatch(/file too large/);
    expect(parsed.error.message).toContain(String(oversize));
    expect(fetchMock.mock.calls.some(([u]) => isUploadUrl(u))).toBe(false);
  });

  it("AC4: base64 decoded length over 100MB → 413 with the actual decoded byte count", async () => {
    // 139810136 base64 chars decode to 104857602 bytes (just over the cap).
    const decoded = 104857602;
    const oversizeB64 = "A".repeat(139810136);

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      base64: oversizeB64,
      filename: "huge.bin",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(413);
    expect(parsed.error.message).toMatch(/file too large/);
    expect(parsed.error.message).toContain(String(decoded));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC5: unreadable filePath → 404 that names the gateway-host requirement + points at url / base64", async () => {
    const enoent: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
    enoent.code = "ENOENT";
    vi.mocked(fsPromises.stat).mockRejectedValueOnce(enoent);

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/home/runner/dev/sandboxes/workspace/out/evidence.png",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(404);
    // 既有前缀保留 (0.6.0 consumer 兼容) + 新增可诊断指引
    expect(parsed.error.message).toMatch(/file not found/);
    expect(parsed.error.message).toMatch(/gateway host/);
    expect(parsed.error.message).toMatch(/sandbox-local/);
    expect(parsed.error.message).toMatch(/gateway 主机可见/);
    expect(parsed.error.message).toContain("url");
    expect(parsed.error.message).toContain("base64");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((result.details as string).length).toBeLessThan(100);
  });

  it("AC5: url download 404 → 502 carrying the upstream status + target URL, never 'file not found'", async () => {
    const longUrl =
      "https://artifacts.example.com/runs/42/very/deep/path/evidence-with-a-really-long-name.png?X-Goog-Signature=" +
      "a".repeat(120);
    fetchMock.mockImplementation(async (u: unknown) => {
      if (isUploadUrl(u)) return jsonUploadResponse();
      return new Response("no such object", { status: 404, statusText: "Not Found" });
    });

    const result = await uploadAttachment({ issueIdOrKey: "SSSS-454", url: longUrl });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(502);
    expect(parsed.error.message).toMatch(/url download failed/);
    expect(parsed.error.message).toContain("HTTP 404");
    expect(parsed.error.message).toContain("artifacts.example.com/runs/42");
    expect(parsed.error.message).toContain("…"); // URL truncated, not echoed whole
    // 反断言: 不误报为「文件不存在」
    expect(parsed.error.message).not.toMatch(/file not found/);
    expect(fetchMock.mock.calls.some(([u]) => isUploadUrl(u))).toBe(false);
  });

  it("AC5: url network error → 502 with the underlying reason, never 'file not found'", async () => {
    fetchMock.mockImplementation(async (u: unknown) => {
      if (isUploadUrl(u)) return jsonUploadResponse();
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    });

    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      url: "https://down.example.com/a.png",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.status).toBe(502);
    expect(parsed.error.message).toMatch(/url download failed/);
    expect(parsed.error.message).toContain("ECONNREFUSED");
    expect(parsed.error.message).toContain("down.example.com/a.png");
    expect(parsed.error.message).not.toMatch(/file not found/);
  });

  it("AC6: filePath success contract is byte-identical to 0.6.0 (no source echo, 5-field attachments)", async () => {
    const result = await uploadAttachment({
      issueIdOrKey: "SSSS-454",
      filePath: "/tmp/upload.txt",
    });
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed).toEqual({
      ok: true,
      method: "upload_attachment",
      request: { issueIdOrKey: "SSSS-454" },
      count: 1,
      attachments: [
        {
          id: "att-100",
          filename: "hello.txt",
          size: 11,
          mimeType: "text/plain",
          content: "https://api.atlassian.com/.../att-100",
        },
      ],
    });
    expect(result.details as string).toBe("已上传 upload.txt (1024 字节) 至 SSSS-454");
    const [uploadUrlArg] = uploadCall(fetchMock);
    expect(uploadUrlArg).toBe(ATLASSIAN_UPLOAD_URL);
  });
});
