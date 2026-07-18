import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10; // max conversation turns kept per user
const GROQ_MODEL = "llama-3.3-70b-versatile";
const FALLBACK_MESSAGE =
  "Sorry, I ran into a problem reaching my AI brain. Please try again in a moment! 🙏";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConversationTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

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

  // Keep only the last MAX_HISTORY turns
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ---------------------------------------------------------------------------
// Groq helper (OpenAI-compatible SDK pointed at Groq's base URL)
// ---------------------------------------------------------------------------

async function askGroq(chatId: number, userText: string): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const groq = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  // Append user turn to history first
  appendHistory(chatId, "user", userText);
  const messages = getHistory(chatId) as OpenAI.ChatCompletionMessageParam[];

  console.log(`[Groq] Sending prompt for chat ${chatId}: "${userText}"`);

  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages,
  });

  const replyText =
    response.choices[0]?.message?.content?.trim() ??
    "I got an empty response — please try again.";

  console.log(
    `[Groq] Reply received for chat ${chatId}: "${replyText.slice(0, 120)}${replyText.length > 120 ? "…" : ""}"`,
  );

  // Store assistant reply in history
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

  const groqKey = process.env["GROQ_API_KEY"];
  if (!groqKey) {
    console.error(
      "[Bot] GROQ_API_KEY is not set — Telegram bot will NOT start.",
    );
    return;
  }

  console.log(
    `[Bot] GROQ_API_KEY at startup — length: ${groqKey.length}, first6: "${groqKey.slice(0, 6)}"`,
  );

  // Long polling — no webhook URL needed
  const bot = new TelegramBot(token, { polling: true });

  console.log("[Bot] Telegram bot started with long polling ✅");

  // Handle every plain text message
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userText = msg.text;
    const senderName =
      msg.from?.username ??
      `${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim() ||
      String(chatId);

    // Ignore non-text messages (photos, stickers, etc.)
    if (!userText) {
      return;
    }

    console.log(
      `[Telegram] Message received — from: @${senderName} (chat ${chatId}) | text: "${userText}"`,
    );

    try {
      const reply = await askGroq(chatId, userText);

      await bot.sendMessage(chatId, reply);
      console.log(`[Telegram] Reply sent to chat ${chatId} ✅`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] Error processing message from chat ${chatId}: ${message}`);
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

  // Log polling errors without crashing
  bot.on("polling_error", (err) => {
    console.error("[Bot] Polling error:", err.message);
  });
}
