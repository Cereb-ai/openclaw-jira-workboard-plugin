/**
 * upload_attachment handler tests.
 *
 * Coverage:
 *   - Happy path: real file → POST hits Atlassian attachments endpoint with
 *     the right URL, auth headers (Bearer + X-Atlassian-Token: no-check),
 *     multipart body, and returns the parsed attachments array.
 *   - Validation: missing issueIdOrKey, missing filePath.
 *   - file not found: fs.stat throws ENOENT → ok:false with status 404.
 *   - file too large: file > 100 MB → ok:false with status 413, no HTTP call.
 *   - Upstream error: non-2xx from Jira surfaces as ok:false with the
 *     server's status code.
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
    const actual = (await importOriginal());
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
const fakeFileStat = (size) => ({
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
describe("upload_attachment", () => {
    let fetchMock;
    beforeEach(() => {
        vi.mocked(fsPromises.stat).mockReset();
        vi.mocked(fsPromises.readFile).mockReset();
        vi.mocked(fsPromises.stat).mockResolvedValue(fakeFileStat(1024));
        vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("hello world"));
        fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
            {
                id: "att-100",
                filename: "hello.txt",
                size: 11,
                mimeType: "text/plain",
                content: "https://api.atlassian.com/.../att-100",
            },
        ]), { status: 200, headers: { "content-type": "application/json" } }));
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });
    it("AC-UA-1: happy path — real file → POST to attachments endpoint, returns attachments", async () => {
        const result = await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/tmp/upload.txt",
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(true);
        expect(parsed.method).toBe("upload_attachment");
        expect(parsed.attachments).toHaveLength(1);
        expect(parsed.attachments[0]).toEqual({
            id: "att-100",
            filename: "hello.txt",
            size: 11,
            mimeType: "text/plain",
            content: "https://api.atlassian.com/.../att-100",
        });
        expect(parsed.summary.issueIdOrKey).toBe("SSSS-454");
        expect(parsed.summary.filename).toBe("upload.txt");
    });
    it("AC-UA-2: request URL is /issue/{key}/attachments under atlassian cloud base", async () => {
        await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/tmp/upload.txt",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl, init] = fetchMock.mock.calls[0];
        expect(calledUrl).toBe("https://api.atlassian.com/ex/jira/test-cloud-123/rest/api/3/issue/SSSS-454/attachments");
        expect(init.method).toBe("POST");
    });
    it("AC-UA-3: auth headers — Bearer token + X-Atlassian-Token: no-check + Accept json", async () => {
        await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/tmp/upload.txt",
        });
        const [, init] = fetchMock.mock.calls[0];
        const headers = init.headers;
        expect(headers["Authorization"]).toBe("Bearer test-token-abc");
        expect(headers["X-Atlassian-Token"]).toBe("no-check");
        expect(headers["Accept"]).toBe("application/json");
    });
    it("AC-UA-4: body is FormData with one 'file' part", async () => {
        await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/tmp/upload.txt",
        });
        const [, init] = fetchMock.mock.calls[0];
        expect(init.body).toBeInstanceOf(FormData);
    });
    it("AC-UA-5: file not found → ok:false with status 404, no HTTP call", async () => {
        const enoent = new Error("ENOENT: no such file");
        enoent.code = "ENOENT";
        vi.mocked(fsPromises.stat).mockRejectedValueOnce(enoent);
        const result = await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/tmp/does-not-exist.txt",
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.status).toBe(404);
        expect(parsed.error.message).toMatch(/file not found/);
        expect(parsed.error.message).toContain("/tmp/does-not-exist.txt");
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("AC-UA-6: file too large (101 MB) → ok:false with status 413, no HTTP call", async () => {
        const oversize = 101 * 1024 * 1024;
        vi.mocked(fsPromises.stat).mockResolvedValueOnce(fakeFileStat(oversize));
        const result = await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/tmp/huge.bin",
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.status).toBe(413);
        expect(parsed.error.message).toMatch(/file too large/);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fsPromises.readFile).not.toHaveBeenCalled();
    });
    it("AC-UA-7: rejects missing issueIdOrKey", async () => {
        const result = await uploadAttachment({ filePath: "/tmp/upload.txt" });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.status).toBe(400);
        expect(parsed.error.message).toMatch(/issueIdOrKey/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("AC-UA-8: rejects missing filePath", async () => {
        const result = await uploadAttachment({ issueIdOrKey: "SSSS-454" });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.status).toBe(400);
        expect(parsed.error.message).toMatch(/filePath/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("AC-UA-9: upstream 401 surfaces as ok:false with status 401", async () => {
        fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401, statusText: "Unauthorized" }));
        const result = await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/tmp/upload.txt",
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.status).toBe(401);
        expect(parsed.error.message).toMatch(/HTTP 401/);
    });
    it("AC-UA-10: filename in request summary is basename of filePath", async () => {
        const result = await uploadAttachment({
            issueIdOrKey: "SSSS-454",
            filePath: "/var/data/screenshots/2026-07-01.png",
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.summary.filename).toBe("2026-07-01.png");
    });
});
