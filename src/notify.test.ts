import test, { afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import { pingHealthchecks, resolveChatId, sendTelegram } from "./notify.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init?: RequestInit };

/** Record every request and reply with the given response. */
function stubFetch(
  response: { ok?: boolean; status?: number; body?: unknown; text?: string } = {},
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body ?? {},
      text: async () => response.text ?? "",
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe("sendTelegram", () => {
  test("posts the message to the configured chat", async () => {
    const calls = stubFetch();
    await sendTelegram(
      { TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42" },
      "hello",
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.includes("/bottok/sendMessage"));
    const body = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(body.chat_id, "42");
    assert.equal(body.text, "hello");
    assert.equal(body.disable_web_page_preview, true);
  });

  test("truncates past Telegram's limit rather than being rejected", async () => {
    // Losing the tail of a log excerpt is recoverable; losing the whole alert is not.
    const calls = stubFetch();
    await sendTelegram({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }, "x".repeat(9000));
    const body = JSON.parse(String(calls[0]!.init!.body));
    assert.ok(body.text.length <= 4096);
    assert.ok(body.text.endsWith("truncated, see links above"));
  });

  test("throws when Telegram rejects the send", async () => {
    stubFetch({ ok: false, status: 403, text: "forbidden" });
    await assert.rejects(
      sendTelegram({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }, "hi"),
      /Telegram send failed: 403/,
    );
  });
});

describe("resolveChatId", () => {
  test("takes the most recent chat", async () => {
    stubFetch({
      body: {
        ok: true,
        result: [
          { message: { chat: { id: 111 } } },
          { message: { chat: { id: 222 } } },
        ],
      },
    });
    assert.equal(await resolveChatId("tok"), "222");
  });

  test("supports channel posts as well as direct messages", async () => {
    stubFetch({ body: { ok: true, result: [{ channel_post: { chat: { id: -100 } } }] } });
    assert.equal(await resolveChatId("tok"), "-100");
  });

  test("explains the missing first message rather than failing obscurely", async () => {
    // Telegram will not reveal a chat to a bot nobody has spoken to, and that is the single most
    // likely thing a new user gets wrong.
    stubFetch({ body: { ok: true, result: [] } });
    await assert.rejects(resolveChatId("tok"), /Send your bot any message first/);
  });

  test("surfaces an API-level failure", async () => {
    stubFetch({ body: { ok: false, description: "unauthorized" } });
    await assert.rejects(resolveChatId("bad"), /getUpdates failed/);
  });
});

describe("pingHealthchecks", () => {
  test("pings the plain url on success", async () => {
    const calls = stubFetch();
    await pingHealthchecks({ HEALTHCHECKS_PING_URL: "https://hc/x" });
    assert.deepEqual(calls.map((c) => c.url), ["https://hc/x"]);
  });

  test("pings the fail endpoint when the run failed", async () => {
    const calls = stubFetch();
    await pingHealthchecks({ HEALTHCHECKS_PING_URL: "https://hc/x" }, { failed: true });
    assert.deepEqual(calls.map((c) => c.url), ["https://hc/x/fail"]);
  });

  test("does nothing when no url is configured", async () => {
    const calls = stubFetch();
    await pingHealthchecks({});
    assert.equal(calls.length, 0);
  });

  test("swallows a failed ping so it cannot mask the run's own result", async () => {
    // If the ping cannot get out, healthchecks.io notices the silence by itself. Throwing here
    // would replace a real error message with a networking one.
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await assert.doesNotReject(pingHealthchecks({ HEALTHCHECKS_PING_URL: "https://hc/x" }));
  });
});
