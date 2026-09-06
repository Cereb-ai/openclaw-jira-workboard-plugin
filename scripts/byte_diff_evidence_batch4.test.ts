/**
 * Byte-diff evidence (CP-2715 batch 4 — final batch, 12-tool rollout close).
 *
 * Run: `npx vitest run scripts/byte_diff_evidence_batch4.test.ts --reporter=verbose`
 *
 * Captures content+details bytes for the 2 attachment tools (get_attachment
 * + upload_attachment) and contrasts NEW shape (this branch, slim v0.5 §5/§6)
 * with the synthesized OLD shape (CP-2710-era: summary block + request
 * echoes). Output is a JSON report consumed by the PR description and the
 * Jira evidence comment.
 *
 * Why synthesize OLD shape inline: the CP-2715 branch replaces the old
 * implementation, so we cannot `git checkout master` and run it under the
 * same vitest process. The OLD shapes here are reconstructed from the
 * description (L138-153 of get_attachment.ts and L151-162 of
 * upload_attachment.ts at master=e8823e9).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/http.js", () => ({
  jiraGet: vi.fn(),
  jiraPost: vi.fn(),
  jiraPut: vi.fn(),
  JiraHttpError: class extends Error {
    constructor(public status: number, public statusText: string, public body: string) {
      super(`HTTP ${status} ${statusText}`);
    }
  },
  buildUrl: (_cfg: { cloudId: string }, path: string) =>
    `https://api.atlassian.com/ex/jira/test-cloud/rest/api/3/${path}`,
  authHeaders: (cfg: { atstToken: string }) => ({
    Authorization: `Bearer ${cfg.atstToken}`,
    Accept: "application/json",
  }),
}));

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: () => ({
      atstToken: "test-token",
      cloudId: "test-cloud",
      proxy: "",
      defaultAssigneeAccountId: "",
    }),
    atlassianApiBase: (cloudId: string) =>
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`,
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
  },
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

import { jiraGet } from "../src/http.js";
import * as fsPromises from "node:fs/promises";
import { getAttachment } from "../src/handlers/get_attachment.js";
import { uploadAttachment } from "../src/handlers/upload_attachment.js";

function bytes(s: any) {
  return Buffer.byteLength(typeof s === "string" ? s : JSON.stringify(s), "utf8");
}

describe("byte_diff_evidence (CP-2715 batch 4)", () => {
  it("captures content+details bytes for get_attachment + upload_attachment (NEW vs OLD)", async () => {
    const out: any[] = [];

    // ─── 1. get_attachment (default save path) ──────────────────────────
    {
      vi.mocked(jiraGet).mockReset();
      vi.mocked(fsPromises.mkdir as any).mockReset?.();
      vi.mocked(fsPromises.writeFile as any).mockReset?.();
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined as never);
      vi.mocked(jiraGet).mockResolvedValueOnce({
        id: "12345",
        filename: "hello.txt",
        size: 11,
        mimeType: "text/plain",
        content: "https://api.media.atlassian.com/.../att-100",
      });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(Buffer.from("hello world"), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const r = await getAttachment({ attachmentId: "12345" });
      const newContent = JSON.parse(r.content[0].text as string);

      // OLD shape (master=e8823e9, L138-153): summary block + request.saveToPath echo
      const oldContent = {
        ok: true,
        method: "get_attachment",
        request: { attachmentId: "12345", saveToPath: undefined },
        path: "/tmp/openclaw-attachments/12345.txt",
        size: 11,
        mimeType: "text/plain",
        filename: "hello.txt",
        summary: {
          attachmentId: "12345",
          path: "/tmp/openclaw-attachments/12345.txt",
          size: 11,
          mimeType: "text/plain",
          filename: "hello.txt",
        },
      };

      out.push({
        tool: "get_attachment (default save path, att 12345)",
        content_keys_new: Object.keys(newContent),
        content_keys_old: Object.keys(oldContent),
        new_content_bytes: bytes(newContent),
        old_content_bytes: bytes(oldContent),
        new_details_bytes: bytes(r.details),
        new_details_str: r.details,
        old_details_bytes: bytes(oldContent),
        delta_content_pct:
          Math.round(((bytes(oldContent) - bytes(newContent)) / bytes(oldContent)) * 100),
      });

      vi.unstubAllGlobals();
    }

    // ─── 2. upload_attachment (short filePath) ─────────────────────────
    {
      vi.mocked(fsPromises.stat).mockReset();
      vi.mocked(fsPromises.readFile).mockReset();
      vi.mocked(fsPromises.stat).mockResolvedValue(
        ({
          size: 12345,
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
        }) as never,
      );
      vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("x") as never);

      const atlassianResponse = [
        {
          id: "att-100",
          self: "https://api.atlassian.com/.../attachment/100",
          filename: "screenshot.png",
          author: { accountId: "u1", displayName: "Test User" },
          size: 12345,
          mimeType: "image/png",
          content: "https://api.media.atlassian.com/.../att-100",
          thumbnail: "https://api.media.atlassian.com/.../att-100/thumb",
          created: "2026-09-06T10:00:00.000+0000",
          _links: { self: "https://api.atlassian.com/.../att-100" },
        },
      ];
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(atlassianResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const r = await uploadAttachment({
        issueIdOrKey: "SSSS-454",
        filePath: "/tmp/screenshot.png",
      });
      const newContent = JSON.parse(r.content[0].text as string);

      // OLD shape (master=e8823e9, L151-162): summary block + request echoes + raw attachments pass-through
      const oldContent = {
        ok: true,
        method: "upload_attachment",
        request: {
          issueIdOrKey: "SSSS-454",
          filePath: "/tmp/screenshot.png",
          size: 12345,
          filename: "screenshot.png",
        },
        attachments: atlassianResponse,
        summary: {
          issueIdOrKey: "SSSS-454",
          filePath: "/tmp/screenshot.png",
          filename: "screenshot.png",
          size: 12345,
          attachmentCount: 1,
        },
      };

      out.push({
        tool: "upload_attachment (short path, SSSS-454)",
        content_keys_new: Object.keys(newContent),
        content_keys_old: Object.keys(oldContent),
        new_content_bytes: bytes(newContent),
        old_content_bytes: bytes(oldContent),
        new_details_bytes: bytes(r.details),
        new_details_str: r.details,
        old_details_bytes: bytes(oldContent),
        delta_content_pct:
          Math.round(((bytes(oldContent) - bytes(newContent)) / bytes(oldContent)) * 100),
      });

      vi.unstubAllGlobals();
    }

    // ─── 3. upload_attachment (LONG filePath — worst-case echo) ────────
    {
      const longPath =
        "/var/data/screenshots/2026-09-06/project-x/very/deep/subdir/screenshot-v3-final-evidence.png";

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "att-200",
              self: "https://api.atlassian.com/.../attachment/200",
              filename: "screenshot-v3-final-evidence.png",
              author: { accountId: "u1", displayName: "Test User" },
              size: 1048576,
              mimeType: "image/png",
              content: "https://api.media.atlassian.com/.../att-200",
              thumbnail: "https://api.media.atlassian.com/.../att-200/thumb",
              created: "2026-09-06T10:00:00.000+0000",
              _links: { self: "https://api.atlassian.com/.../att-200" },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const r = await uploadAttachment({
        issueIdOrKey: "WTO-1234",
        filePath: longPath,
      });
      const newContent = JSON.parse(r.content[0].text as string);

      const oldContent = {
        ok: true,
        method: "upload_attachment",
        request: {
          issueIdOrKey: "WTO-1234",
          filePath: longPath,
          size: 1048576,
          filename: "screenshot-v3-final-evidence.png",
        },
        attachments: [
          {
            id: "att-200",
            self: "https://api.atlassian.com/.../attachment/200",
            filename: "screenshot-v3-final-evidence.png",
            author: { accountId: "u1", displayName: "Test User" },
            size: 1048576,
            mimeType: "image/png",
            content: "https://api.media.atlassian.com/.../att-200",
            thumbnail: "https://api.media.atlassian.com/.../att-200/thumb",
            created: "2026-09-06T10:00:00.000+0000",
            _links: { self: "https://api.atlassian.com/.../att-200" },
          },
        ],
        summary: {
          issueIdOrKey: "WTO-1234",
          filePath: longPath,
          filename: "screenshot-v3-final-evidence.png",
          size: 1048576,
          attachmentCount: 1,
        },
      };

      out.push({
        tool: "upload_attachment (LONG path 113B echo, WTO-1234)",
        content_keys_new: Object.keys(newContent),
        content_keys_old: Object.keys(oldContent),
        new_content_bytes: bytes(newContent),
        old_content_bytes: bytes(oldContent),
        new_details_bytes: bytes(r.details),
        new_details_str: r.details,
        old_details_bytes: bytes(oldContent),
        delta_content_pct:
          Math.round(((bytes(oldContent) - bytes(newContent)) / bytes(oldContent)) * 100),
      });

      vi.unstubAllGlobals();
    }

    console.log("\n=== CP-2715 batch 4 byte-diff evidence ===");
    console.log(JSON.stringify(out, null, 2));
    console.log("=== end ===\n");
    expect(out).toHaveLength(3);
  });
});
