import TelegramBot from "node-telegram-bot-api";
import type { ChatId } from "node-telegram-bot-api";

type SendMessageOptions = Parameters<TelegramBot["sendMessage"]>[2];

const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_TEXT_CHUNK_SIZE = 4000;

function splitOversizedText(
  text: string,
  maxLength = TELEGRAM_TEXT_CHUNK_SIZE,
): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    let splitAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\r\n\r\n"),
    );

    if (splitAt <= 0) {
      splitAt = Math.max(
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
      );
      if (splitAt > 0 && [".", "!", "?"].includes(window[splitAt]))
        splitAt += 1;
    }

    if (splitAt <= 0) splitAt = maxLength;

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function sendTextMessage(
  bot: TelegramBot,
  chatId: ChatId,
  text: string,
  options?: SendMessageOptions,
): Promise<void> {
  const parts = splitOversizedText(text);
  for (const part of parts) {
    await bot.sendMessage(
      chatId,
      part.slice(0, TELEGRAM_MESSAGE_LIMIT),
      options,
    );
  }
}
