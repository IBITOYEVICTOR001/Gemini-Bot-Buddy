import TelegramBot from "node-telegram-bot-api";
import { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10; // max conversation turns kept per user
const GEMINI_MODEL = "gemini-2.5-flash";
const FALLBACK_MESSAGE =
  "Sorry, I ran into a problem reaching my AI brain. Please try again in a moment! 🙏";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationTurn {
  role: "user" | "model";
  parts: { text: string }[];
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
  role: "user" | "model",
  text: string,
): void {
  const history = getHistory(chatId);
  history.push({ role, parts: [{ text }] });

  // Keep only the last MAX_HISTORY turns (each turn = 1 entry)
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function askGemini(chatId: number, userText: string): Promise<string> {
  const apiKey = process.env["GEMINI_API_KEY"];

  // Diagnostic: confirm key is present without exposing it
  console.log(
    `[Gemini] GEMINI_API_KEY — defined: ${!!apiKey}, length: ${apiKey?.length ?? 0}, first5: "${apiKey?.slice(0, 5) ?? "N/A"}"`,
  );

  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });

  // Build history BEFORE appending the new user turn
  const history = getHistory(chatId);

  console.log(
    `[Gemini] Sending prompt for chat ${chatId} (history turns: ${history.length}): "${userText}"`,
  );

  try {
    const chat = ai.chats.create({
      model: GEMINI_MODEL,
      history: history.length > 0 ? history : undefined,
    });

    const response = await chat.sendMessage({ message: userText });

    const replyText =
      response.text?.trim() ?? "I got an empty response — please try again.";

    console.log(
      `[Gemini] Reply received for chat ${chatId}: "${replyText.slice(0, 120)}${replyText.length > 120 ? "…" : ""}"`,
    );

    return replyText;
  } catch (geminiErr: unknown) {
    // Print every piece of information available on the error
    console.error("[Gemini] ===== FULL ERROR DUMP =====");
    console.error("[Gemini] typeof error:", typeof geminiErr);
    console.error("[Gemini] error (raw):", geminiErr);

    if (geminiErr instanceof Error) {
      console.error("[Gemini] error.name:", geminiErr.name);
      console.error("[Gemini] error.message:", geminiErr.message);
      console.error("[Gemini] error.stack:", geminiErr.stack);
    }

    // The @google/genai SDK attaches HTTP details to the error object
    const e = geminiErr as Record<string, unknown>;
    if (e["status"] !== undefined)
      console.error("[Gemini] error.status:", e["status"]);
    if (e["statusText"] !== undefined)
      console.error("[Gemini] error.statusText:", e["statusText"]);
    if (e["errorDetails"] !== undefined)
      console.error(
        "[Gemini] error.errorDetails:",
        JSON.stringify(e["errorDetails"], null, 2),
      );
    if (e["response"] !== undefined)
      console.error(
        "[Gemini] error.response:",
        JSON.stringify(e["response"], null, 2),
      );

    console.error("[Gemini] ===== END ERROR DUMP =====");
    throw geminiErr; // re-throw so the outer catch sends the fallback
  }
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

  const geminiKey = process.env["GEMINI_API_KEY"];
  if (!geminiKey) {
    console.error(
      "[Bot] GEMINI_API_KEY is not set — Telegram bot will NOT start.",
    );
    return;
  }

  // Long polling — no webhook URL needed
  const bot = new TelegramBot(token, { polling: true });

  console.log("[Bot] Telegram bot started with long polling ✅");

  // Handle every plain text message
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userText = msg.text;
    const senderName =
      msg.from?.username ??
      `${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim() ??
      String(chatId);

    // Ignore non-text messages (photos, stickers, etc.)
    if (!userText) {
      return;
    }

    console.log(
      `[Telegram] Message received — from: @${senderName} (chat ${chatId}) | text: "${userText}"`,
    );

    try {
      // Append user turn BEFORE calling Gemini (Gemini will read history without this turn)
      appendHistory(chatId, "user", userText);

      // Call Gemini
      const reply = await askGemini(chatId, userText);

      // Store Gemini's reply in history
      appendHistory(chatId, "model", reply);

      // Send reply back to Telegram
      await bot.sendMessage(chatId, reply);
      console.log(`[Telegram] Reply sent to chat ${chatId} ✅`);
    } catch (err) {
      console.error(
        `[Bot] Error processing message from chat ${chatId}:`,
        err,
      );

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
