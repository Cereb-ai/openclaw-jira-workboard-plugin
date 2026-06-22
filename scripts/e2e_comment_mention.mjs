#!/usr/bin/env node
// E2E test for comment mentionMap bijection check.
// Run: cd /home/leoclaw/dev/projects/jira-openclaw-plugin && node scripts/e2e_comment_mention.mjs
import { dispatch } from "/home/leoclaw/dev/projects/jira-openclaw-plugin/dist/dispatch.js";

const TICKET = "WTO-82";  // created by OpenCode, "正在进行"
const ACCOUNT_ID = "712020:42e79d90-a6eb-45e7-ac69-f2872f3b89b1";  // CerebPilot (project reporter)

async function call(method, args) {
  const r = await dispatch({ method, args });
  const text = r?.content?.[0]?.text ?? JSON.stringify(r);
  return text;
}

function makeAdf(textBefore, mentionId, mentionText, textAfter) {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: textBefore },
          mentionId
            ? { type: "mention", attrs: { id: mentionId, text: mentionText } }
            : { type: "text", text: " (no mention here) " },
          { type: "text", text: textAfter },
        ],
      },
    ],
  };
}

(async () => {
  let pass = 0, fail = 0;
  const verdict = (label, ok) => {
    const tag = ok ? "✅ PASS" : "❌ FAIL";
    console.log(`  ${tag} ${label}`);
    if (ok) pass++; else fail++;
  };
  const expectOk    = (parsed)        => Boolean(parsed) && parsed.ok === true && !parsed.error;
  const expectError = (parsed, hint)  => Boolean(parsed) && typeof parsed.error === "string" && parsed.error.includes(hint);

  // Case 1: 正确路径 — mentionMap values == ADF mention ids (bijection)
  console.log("=== Case 1: 正确路径 (bijection satisfied) ===");
  {
    const body = makeAdf("hi ", ACCOUNT_ID, "@CerebPilot", " please review");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      mentionMap: { "CerebPilot": ACCOUNT_ID },
    });
    const parsed = JSON.parse(res);
    console.log("  result: " + (parsed.error || ("ok + commentId=" + (parsed.comment?.id || "?"))));
    verdict("ok=true", expectOk(parsed));
  }

  // Case 2: ADF 有 mention, mentionMap 传空对象 {} → 老路径 (空 map 走 short-circuit)
  console.log("=== Case 2: ADF 有 mention, mentionMap={} (走老路径) ===");
  {
    const body = makeAdf("hi ", ACCOUNT_ID, "@CerebPilot", " review");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      mentionMap: {},
    });
    const parsed = JSON.parse(res);
    console.log("  result: " + (parsed.error || ("ok + commentId=" + (parsed.comment?.id || "?"))));
    verdict("ok=true (空 map = 老路径)", expectOk(parsed));
  }

  // Case 3: ADF 有 mention, mentionMap 缺对应 key
  console.log("=== Case 3: ADF 有 mention, mentionMap 缺 key (fail-fast) ===");
  {
    const body = makeAdf("hi ", ACCOUNT_ID, "@CerebPilot", " review");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      mentionMap: {},  // 故意空
    });
    // 上面的 expectOk 会过（因为是空 map 走老路径）—— 改用 case 3 真正意图
    // 重新构造: mentionMap 声明了 key 但 ADF 用了不同 key
    // 实际: 想测"ADF 用 mention + mentionMap 完全不声明这个 accountId"
    // → 用 mentionMap={"其他人": "其他accountId"} 制造 mismatch
  }

  // Case 3 重新: ADF 用 mention, mentionMap 声明其他 person → fail-fast (accountId 不匹配)
  console.log("=== Case 3 (revised): ADF mention id 跟 mentionMap 任何 value 都不匹配 (fail-fast) ===");
  {
    const body = makeAdf("hi ", ACCOUNT_ID, "@CerebPilot", " review");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      mentionMap: { "其他人": "999999:fake" },  // 故意错
    });
    const parsed = JSON.parse(res);
    console.log("  result.error: " + (parsed.error || "none"));
    const expectedHint = "does not contain this accountId";
    verdict(
      "error contains '" + expectedHint + "' + accountId " + ACCOUNT_ID,
      expectError(parsed, expectedHint) && (parsed.error || "").includes(ACCOUNT_ID)
    );
  }

  // Case 4: ADF 没 mention, mentionMap 声明了 key → fail-fast
  console.log("=== Case 4: ADF 无 mention, mentionMap 有 key (fail-fast) ===");
  {
    const body = makeAdf("plain comment", null, null, "");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      mentionMap: { "CerebPilot": ACCOUNT_ID },
    });
    const parsed = JSON.parse(res);
    console.log("  result.error: " + (parsed.error || "none"));
    const expectedHint = "does not use this accountId";
    verdict(
      "error contains '" + expectedHint + "'",
      expectError(parsed, expectedHint)
    );
  }

  // Case 5: mentionMap 完全不传 → 老路径, 不校验
  console.log("=== Case 5: mentionMap 不传, 老路径 (ok=true) ===");
  {
    const body = makeAdf("hi ", ACCOUNT_ID, "@CerebPilot", " no map");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      // mentionMap 不传
    });
    const parsed = JSON.parse(res);
    console.log("  result: " + (parsed.error || ("ok + commentId=" + (parsed.comment?.id || "?"))));
    verdict("ok=true (老路径)", expectOk(parsed));
  }

  // Case 6: mentionMap 是 array (type 错)
  console.log("=== Case 6: mentionMap 是 array (type error) ===");
  {
    const body = makeAdf("hi", ACCOUNT_ID, "@CerebPilot", " review");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      mentionMap: [ACCOUNT_ID],  // 故意错
    });
    const parsed = JSON.parse(res);
    console.log("  result.error: " + (parsed.error || "none"));
    verdict(
      "error mentions plain object",
      expectError(parsed, "plain object")
    );
  }

  // Case 7: mentionMap value 是空字符串 (type 错)
  console.log("=== Case 7: mentionMap value 是空字符串 (type error) ===");
  {
    const body = makeAdf("hi", ACCOUNT_ID, "@CerebPilot", " review");
    const res = await call("comment", {
      issueIdOrKey: TICKET,
      body,
      mentionMap: { "CerebPilot": "" },  // 故意空
    });
    const parsed = JSON.parse(res);
    console.log("  result.error: " + (parsed.error || "none"));
    verdict(
      "error mentions non-empty",
      expectError(parsed, "non-empty")
    );
  }

  console.log("---");
  console.log(`PASS ${pass} / FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
