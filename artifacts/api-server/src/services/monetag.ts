import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

const SPONSORED_MESSAGE = "📢 Sponsored: Check this out";

export async function sendSponsoredSmartLink(bot: TelegramBot, chatId: number): Promise<void> {
  const smartLinkUrl = process.env["MONETAG_SMARTLINK_URL"]?.trim();

  if (!smartLinkUrl) {
    console.log("[Monetag] Skipping sponsored message: MONETAG_SMARTLINK_URL is not set.");
    return;
  }

  try {
    await bot.sendMessage(chatId, SPONSORED_MESSAGE, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Learn more",
              url: smartLinkUrl,
            },
          ],
        ],
      },
    });
    console.log("[Monetag] Sponsored SmartLink message sent successfully.", { chatId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("[Monetag] Skipping sponsored message because the send failed.", { error: message });
    logger.warn({ err: message }, "Skipping sponsored message because Monetag SmartLink send failed");
  }
}
