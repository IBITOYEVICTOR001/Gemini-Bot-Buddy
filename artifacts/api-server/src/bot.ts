import TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import axios from "axios";
import { PDFParse } from "pdf-parse";
import { logger } from "./lib/logger";
import {
  analyzeDataset,
  decideSearch,
  generateConversationReply,
  generateCreativeOutput,
  generateGame,
  generateCodeSnippet,
  generateTranslation,
  type ChatMessage,
} from "./services/groq";
import { runTavilySearch } from "./services/tavily";
import { createVideoJob, pollVideoCompletion } from "./services/json2video";
import { synthesizeSpeech, transcribeAudio } from "./services/hf";

const MAX_HISTORY = 10;
const FALLBACK_MESSAGE =
  "LADEX IS NOT AVAILABLE AT THE MOMENT PLS TRY AGAIN LATER";

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

const conversationHistory = new Map<number, ConversationTurn[]>();

function getHistory(chatId: number): ConversationTurn[] {
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }
  return conversationHistory.get(chatId)!;
}

function appendHistory(chatId: number, role: ConversationTurn["role"], content: string): void {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

function extractImageGenPrompt(text: string): string | null {
  const verbRe = /\b(generate|draw|create|make|design|render|paint|sketch|produce|show me)\b/i;
  const nounRe = /\b(image|picture|photo|illustration|art(?:work)?|painting|portrait|poster|logo|icon|banner|wallpaper|cartoon|drawing|meme|thumbnail|visual|graphic|scene|landscape)\b/i;
  if (!verbRe.test(text) || !nounRe.test(text)) return null;

  const stripped = text
    .replace(/^(generate|draw|create|make|design|render|paint|sketch|produce)(\s+me)?\s+/i, "")
    .replace(/^(an?\s+)?(image|picture|photo|illustration|art(?:work)?|painting|portrait|poster|logo|icon|banner|wallpaper|cartoon|drawing|meme|thumbnail|visual|graphic|scene|landscape)\s+(of\s+)?/i, "")
    .replace(/\b(for me|please)\b/i, "")
    .trim();

  return stripped.length > 0 ? stripped : "a beautiful fantasy landscape";
}

async function handleUserMessage(chatId: number, userText: string): Promise<string> {
  appendHistory(chatId, "user", userText);

  let searchResults = [] as { title: string; url: string; content: string }[];
  try {
    const decision = await decideSearch(userText, getHistory(chatId).map((item) => ({ role: item.role, content: item.content })));
    if (decision.needs_search) {
      searchResults = await runTavilySearch(decision.search_query);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Search decision or Tavily lookup failed");
  }

  const reply = await generateConversationReply(userText, getHistory(chatId).map((item) => ({ role: item.role, content: item.content })), searchResults);
  appendHistory(chatId, "assistant", reply);
  return reply;
}

async function handleVideoGen(
  chatId: number,
  bot: TelegramBot,
  prompt: string,
  orientation: "horizontal" | "vertical" = "horizontal",
): Promise<void> {
  await bot.sendChatAction(chatId, "typing");

  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  const job = await createVideoJob(prompt, imageUrl, orientation);

  await bot.sendMessage(
    chatId,
    `Your video job has been created (project ID: ${job.projectId}). Checking status until it finishes. This may take a minute or two.`,
  );

  const completion = await pollVideoCompletion(job.projectId);

  await bot.sendMessage(chatId, `Your video is ready! Download it here:\n${completion.downloadUrl}`);
}
async function handleVoiceMessage(chatId: number, bot: TelegramBot, msg: Message): Promise<void> {
  const voice = msg.voice;
  if (!voice) return;

  await bot.sendChatAction(chatId, "typing");
  logger.info({ chatId }, "Voice message received, downloading file");

  const url = await bot.getFileLink(voice.file_id);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download voice message: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  logger.info({ chatId, size: buffer.length }, "Voice file downloaded, sending to Whisper");

  const transcript = await transcribeAudio(buffer);
  logger.info({ chatId }, "Transcription complete");

  await bot.sendMessage(chatId, `📝 Transcription:\n${transcript}`);
}
async function handleTextToSpeech(chatId: number, bot: TelegramBot, text: string): Promise<void> {
  const audioBuffer = await synthesizeSpeech(text);
  await bot.sendAudio(chatId, audioBuffer, {
    caption: "Here is the synthesized audio.",
  });
}

async function downloadTelegramFile(bot: TelegramBot, fileId: string): Promise<Buffer> {
  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  if (!res.ok) {
    throw new Error(`Failed to download Telegram file: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function runOcr(imageBuffer: Buffer): Promise<string> {
  const apiKey = process.env["OCR_SPACE_API_KEY"];
  if (!apiKey) throw new Error("OCR_SPACE_API_KEY is not set");

  const formData = new FormData();
  formData.append("apikey", apiKey);
  formData.append("language", "eng");
  formData.append("isOverlayRequired", "false");
  formData.append("detectOrientation", "true");
  formData.append("scale", "true");
  formData.append("file", new Blob([imageBuffer], { type: "image/jpeg" }), "image.jpg");

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`OCR.space HTTP error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    ParsedResults?: Array<{ ParsedText?: string }>;
    IsErroredOnProcessing?: boolean;
    ErrorMessage?: string | string[];
  };

  if (data.IsErroredOnProcessing) {
    const message = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join("; ") : data.ErrorMessage ?? "Unknown error";
    throw new Error(`OCR.space error: ${message}`);
  }

  return (data.ParsedResults ?? []).map((result) => result.ParsedText ?? "").join("\n").trim();
}

async function handlePhotoMessage(chatId: number, bot: TelegramBot, msg: Message): Promise<void> {
  const photos = msg.photo;
  if (!photos?.length) return;
  const fileId = photos[photos.length - 1]!.file_id;
  const caption = msg.caption?.trim() ?? "";

  await bot.sendChatAction(chatId, "typing");

  const buffer = await downloadTelegramFile(bot, fileId);
  const extractedText = await runOcr(buffer);
  if (!extractedText) {
    await bot.sendMessage(chatId, "I could not extract readable text from the image.");
    return;
  }

  if (caption) {
    const translation = await generateTranslation(extractedText, "English");
    await bot.sendMessage(chatId, `📄 Extracted text:\n${extractedText}\n\nTranslation to English:\n${translation}`);
  } else {
    await bot.sendMessage(chatId, `📄 Extracted text:\n${extractedText}`);
  }
}

async function runPdfExtract(buffer: Buffer): Promise<{ text: string; pages: number; truncated: boolean }> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const raw = result.text.trim();
    const truncated = raw.length > 15_000;
    return { text: truncated ? raw.slice(0, 15_000) : raw, pages: result.total, truncated };
  } finally {
    await parser.destroy();
  }
}

async function sendLongMessage(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const maxChunk = 4000;
  for (let offset = 0, part = 1; offset < text.length; offset += maxChunk, part += 1) {
    await bot.sendMessage(chatId, `[Part ${part}]\n${text.slice(offset, offset + maxChunk)}`);
  }
}

async function handleDocumentMessage(chatId: number, bot: TelegramBot, msg: Message): Promise<void> {
  const doc = msg.document;
  if (!doc) return;

  const fileName = doc.file_name ?? "document.pdf";
  const caption = msg.caption?.trim() ?? "";

  if (!doc.mime_type?.includes("pdf") && !fileName.toLowerCase().endsWith(".pdf")) {
    await bot.sendMessage(chatId, "I can only process PDF documents right now.");
    return;
  }

  const buffer = await downloadTelegramFile(bot, doc.file_id);
  const extracted = await runPdfExtract(buffer);
  if (!extracted.text) {
    await bot.sendMessage(chatId, "I could not extract readable text from that PDF.");
    return;
  }

  if (caption) {
    const analysis = await generateConversationReply(caption, [], []);
    await sendLongMessage(bot, chatId, `📄 Extracted text from ${fileName}:\n${extracted.text}\n\nAI analysis:\n${analysis}`);
  } else {
    await sendLongMessage(bot, chatId, `📄 Summary request for ${fileName}:\n${extracted.text}`);
  }
}

let bot: TelegramBot;

export function getBot(): TelegramBot {
  if (!bot) throw new Error("Bot not initialized yet");
  return bot;
}

export async function startBot(): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const groqKey = process.env["GROQ_API_KEY"];
  const webhookUrl = process.env["WEBHOOK_URL"];

  if (!token) {
    console.error("[Bot] TELEGRAM_BOT_TOKEN missing — Execution cancelled.");
    return;
  }

  if (!groqKey) {
    console.error("[Bot] GROQ_API_KEY missing — Execution cancelled.");
    return;
  }

  if (!webhookUrl) {
    console.error("[Bot] WEBHOOK_URL missing — Execution cancelled.");
    return;
  }

  bot = new TelegramBot(token);
  await bot.setWebHook(`${webhookUrl}/api/telegram-webhook`);
  logger.info("[Bot] Telegram webhook set.");

bot.onText(/^\/video\s+(horizontal|vertical)?\s*(.*)$/i, async (msg, match) => {
  if (!msg) return;
  const chatId = msg.chat.id;
  const orientation = (match?.[1] ? match[1].toLowerCase() : "horizontal") as "horizontal" | "vertical";
  const prompt = match?.[2]?.trim();
  if (!prompt) {
    await bot.sendMessage(chatId, "Usage: /video [horizontal|vertical] your prompt");
    return;
  }

  try {
    await handleVideoGen(chatId, bot, prompt, orientation);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Video generation failed");
    await bot.sendMessage(chatId, "Sorry, I couldn't generate that video right now.");
  }
});

  bot.onText(/^\/say\s+(.+)$/i, async (msg, match) => {
    if (!msg || !match?.[1]) return;
    const chatId = msg.chat.id;
    try {
      await handleTextToSpeech(chatId, bot, match[1]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Text-to-speech failed");
      await bot.sendMessage(chatId, "Sorry, I could not generate audio right now.");
    }
  });

  bot.onText(/^\/translate\s+to\s+([A-Za-z]+)\s*:\s*(.+)$/i, async (msg, match) => {
    if (!msg || !match) return;
    const chatId = msg.chat.id;
    const targetLanguage = match[1];
    const text = match[2];
    try {
      const translation = await generateTranslation(text, targetLanguage);
      await bot.sendMessage(chatId, `Translation (${targetLanguage}):\n${translation}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Translation failed");
      await bot.sendMessage(chatId, "Sorry, I couldn't translate that text.");
    }
  });

  bot.onText(/^\/(story|poem|dialogue|project)\s+(.+)$/i, async (msg, match) => {
    if (!msg || !match) return;
    const chatId = msg.chat.id;
    const command = match[1].toLowerCase();
    const topic = match[2];
    try {
      const type = command === "project" ? "projectIdeas" : (command as "story" | "poem" | "dialogue");
      const output = await generateCreativeOutput(type, topic);
      await bot.sendMessage(chatId, output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Creative output failed");
      await bot.sendMessage(chatId, "Sorry, I couldn't generate that creative output.");
    }
  });

  bot.onText(/^\/(hangman|20questions|wordjumble)\s+(.+)$/i, async (msg, match) => {
    if (!msg || !match) return;
    const chatId = msg.chat.id;
    const gameType = match[1].toLowerCase() as "hangman" | "20questions" | "wordjumble";
    const subject = match[2];
    try {
      const game = await generateGame(gameType, subject);
      await bot.sendMessage(chatId, game);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Game generation failed");
      await bot.sendMessage(chatId, "Sorry, I couldn't start that game.");
    }
  });

  bot.onText(/^\/code\s+(.+)$/i, async (msg, match) => {
    if (!msg || !match?.[1]) return;
    const chatId = msg.chat.id;
    try {
      const code = await generateCodeSnippet(match[1], "JavaScript");
      await bot.sendMessage(chatId, code);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Code generation failed");
      await bot.sendMessage(chatId, "Sorry, I couldn't generate code for that request.");
    }
  });

  bot.on("voice", async (msg) => {
    const chatId = msg.chat.id;
    try {
      await handleVoiceMessage(chatId, bot, msg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Voice transcription failed");
      await bot.sendMessage(chatId, "Sorry, I couldn't transcribe that voice message.");
    }
  });

  bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    if (!process.env["OCR_SPACE_API_KEY"]) {
      await bot.sendMessage(chatId, "OCR is not configured on this bot right now.");
      return;
    }

    try {
      await handlePhotoMessage(chatId, bot, msg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Photo OCR failed");
      await bot.sendMessage(chatId, FALLBACK_MESSAGE);
    }
  });

  bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    try {
      await handleDocumentMessage(chatId, bot, msg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Document processing failed");
      await bot.sendMessage(chatId, FALLBACK_MESSAGE);
    }
  });

  bot.on("message", async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;

    if (msg.text.startsWith("/")) return;

    const imagePrompt = extractImageGenPrompt(msg.text);
    if (imagePrompt) {
      try {
        await bot.sendChatAction(chatId, "upload_photo");
        const response = await axios.get(
          `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}`,
          { responseType: "stream", timeout: 15000 },
        );
        await bot.sendPhoto(chatId, response.data, { caption: "Here is your image." });
        return;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, "Image generation fallback failed");
      }
    }

    try {
      const reply = await handleUserMessage(chatId, msg.text);
      await bot.sendMessage(chatId, reply);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Chat response failed");
      await bot.sendMessage(chatId, FALLBACK_MESSAGE);
    }
  });

  bot.on("webhook_error", (error) => {
    logger.error({ err: error.message }, "Webhook error");
  });
}
