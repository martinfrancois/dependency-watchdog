/** Telegram delivery and the external heartbeat. Callers decide which events to send. */

import type { Secrets } from "./types.ts";

const TELEGRAM_LIMIT = 4096;

export async function sendTelegram(cfg: Secrets, text: string): Promise<void> {
  const body = text.length > TELEGRAM_LIMIT
    ? text.slice(0, TELEGRAM_LIMIT - 40) + "\n… truncated, see links above"
    : text;

  const res = await fetch(
    `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.TELEGRAM_CHAT_ID,
        text: body,
        disable_web_page_preview: true,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Resolve the chat id from getUpdates, for first-time setup.
 *
 * Only usable once you have messaged the bot: Telegram will not tell a bot about a chat it has
 * never been spoken to in.
 */
export async function resolveChatId(token: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = (await res.json()) as {
    ok: boolean;
    result: { message?: { chat: { id: number } }; channel_post?: { chat: { id: number } } }[];
  };
  if (!data.ok) throw new Error(`getUpdates failed: ${JSON.stringify(data)}`);
  const chat = data.result
    .map((u) => u.message?.chat ?? u.channel_post?.chat)
    .filter(Boolean)
    .pop();
  if (!chat) {
    throw new Error(
      "No chat found. Send your bot any message first, then run this again.",
    );
  }
  return String(chat.id);
}

/**
 * Ping the dead-man's switch.
 *
 * Called only on a clean completion. If this process dies, the box is off, the network is gone,
 * the timer was disabled or the gh token was revoked, the ping does not happen and
 * healthchecks.io raises the alarm. It is the one component that is neither on this machine nor
 * on GitHub, which is what makes it able to report their absence.
 */
export async function pingHealthchecks(
  cfg: Secrets,
  { failed = false }: { failed?: boolean } = {},
): Promise<void> {
  if (!cfg.HEALTHCHECKS_PING_URL) return;
  const url = failed
    ? `${cfg.HEALTHCHECKS_PING_URL}/fail`
    : cfg.HEALTHCHECKS_PING_URL;
  try {
    await fetch(url, { method: "POST" });
  } catch {
    // A failed ping must not mask the run's own result. healthchecks.io notices the silence.
  }
}
