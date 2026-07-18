import TelegramBot from "node-telegram-bot-api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10; // max conversation turns kept per user
const XAI_MODEL = "grok-3";
const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const FALLBACK_MESSAGE =
  "Sorry, I ran into a problem reaching my AI brain. Please try again in a moment! 🙏";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConversationTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

// xAI Responses API output shapes
interface XAIOutputText {
  type: "output_text";
  text: string;
}

interface XAIMessageOutput {
  type: "message";
  role: "assistant";
  content: XAIOutputText[];
}

interface XAIToolCallOutput {
  type: string; // "web_search_call" | "x_search_call" | …
  id: string;
  status: string;
}

type XAIOutputItem = XAIMessageOutput | XAIToolCallOutput;

interface XAIResponse {
  id: string;
  output: XAIOutputItem[];
  // error shape when the API returns 4xx/5xx with a JSON body
  error?: { message: string; type: string };
}

// ---------------------------------------------------------------------------
// In-memory conversation history — keyed by Telegram chat ID
// ---------------------------------------------------------------------------

const conversationHistory = new Map<number, ConversationTurn[]>();

function getHistory(chatId: number): ConversationTurn[] {
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }
  return conversationHistory.get(chatId)!;
}

function appendHistory(
  chatId: number,
  role: "user" | "assistant",
  text: string,
): void {
  const history = getHistory(chatId);
  history.push({ role, content: text });
  // Trim to the most recent MAX_HISTORY turns
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ---------------------------------------------------------------------------
// xAI Grok helper — Responses API with built-in web_search + x_search tools
// ---------------------------------------------------------------------------

async function askGrok(chatId: number, userText: string): Promise<string> {
  const apiKey = process.env["XAI_API_KEY"];
  if (!apiKey) throw new Error("XAI_API_KEY is not set");

  // Append the user turn before building the payload so it's included
  appendHistory(chatId, "user", userText);
  const input = getHistory(chatId);

  console.log(`[Grok] Sending prompt for chat ${chatId}: "${userText}"`);

  const res = await fetch(XAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      input,
      // Let Grok decide automatically when to search.
      // web_search  — broad live web results
      // x_search    — real-time posts/data from X (formerly Twitter)
      tools: [{ type: "web_search" }, { type: "x_search" }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`xAI API ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as XAIResponse;

  // Log every tool call that was made so we can see in console when searches happen
  const toolCalls = data.output.filter((o) => o.type !== "message");
  if (toolCalls.length > 0) {
    const names = toolCalls.map((t) => t.type).join(", ");
    console.log(`[Grok] Tools invoked for chat ${chatId}: ${names}`);
  }

  // Extract text from the final message output item
  const lastMessage = data.output
    .filter((o): o is XAIMessageOutput => o.type === "message")
    .at(-1);

  const replyText =
    lastMessage?.content
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("") ||
    "I got an empty response — please try again.";

  console.log(
    `[Grok] Reply for chat ${chatId}: "${replyText.slice(0, 120)}${replyText.length > 120 ? "…" : ""}"`,
  );

  // Store only the final plain-text reply in history (not tool-call artefacts)
  appendHistory(chatId, "assistant", replyText);

  return replyText;
}

// ---------------------------------------------------------------------------
// Bot bootstrap
// ---------------------------------------------------------------------------

export function startBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.error(
      "[Bot] TELEGRAM_BOT_TOKEN is not set — Telegram bot will NOT start.",
    );
    return;
  }

  const xaiKey = process.env["XAI_API_KEY"];
  if (!xaiKey) {
    console.error(
      "[Bot] XAI_API_KEY is not set — Telegram bot will NOT start.",
    );
    return;
  }

  console.log(`[Bot] XAI_API_KEY confirmed — length: ${xaiKey.length}`);

  // Long polling — no webhook URL needed
  const bot = new TelegramBot(token, { polling: true });
  console.log("[Bot] Telegram bot started with long polling ✅");

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userText = msg.text;
    const senderName =
      msg.from?.username ??
      (
        `${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim() ||
        String(chatId)
      );

    // Ignore non-text messages (photos, stickers, voice notes, etc.)
    if (!userText) return;

    console.log(
      `[Telegram] Message received — from: @${senderName} (chat ${chatId}) | text: "${userText}"`,
    );

    try {
      const reply = await askGrok(chatId, userText);

      // Telegram hard-limits messages to 4096 chars; truncate gracefully
      const safe =
        reply.length > 4000
          ? reply.slice(0, 4000) + "\n\n…(truncated)"
          : reply;

      await bot.sendMessage(chatId, safe);
      console.log(`[Telegram] Reply sent to chat ${chatId} ✅`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[Bot] Error processing message from chat ${chatId}: ${message}`,
      );
      console.error("[Bot] Full error:", err);

      try {
        await bot.sendMessage(chatId, FALLBACK_MESSAGE);
        console.log(`[Telegram] Fallback message sent to chat ${chatId}`);
      } catch (sendErr) {
        console.error(
          `[Bot] Failed to send fallback message to chat ${chatId}:`,
          sendErr,
        );
      }
    }
  });

  // Log polling errors without crashing the process
  bot.on("polling_error", (err) => {
    console.error("[Bot] Polling error:", err.message);
  });
}
