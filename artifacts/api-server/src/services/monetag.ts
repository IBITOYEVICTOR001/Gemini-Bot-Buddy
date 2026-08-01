import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";
import { sendTextMessage } from "../lib/telegramMessages";

const SPONSORED_MESSAGE = "📢 Sponsored: Check this out";

interface SmartLinkSource {
  name: "Monetag" | "Adsterra";
  url: string;
}

function getAvailableSmartLinks(): SmartLinkSource[] {
  const monetagSmartLinkUrl = process.env["MONETAG_SMARTLINK_URL"]?.trim();
  const adsterraSmartLinkUrl = process.env["ADSTERRA_SMARTLINK_URL"]?.trim();

  return [
    monetagSmartLinkUrl ? { name: "Monetag", url: monetagSmartLinkUrl } : null,
    adsterraSmartLinkUrl
      ? { name: "Adsterra", url: adsterraSmartLinkUrl }
      : null,
  ].filter((smartLink): smartLink is SmartLinkSource => smartLink !== null);
}

function pickSmartLink(smartLinks: SmartLinkSource[]): SmartLinkSource | null {
  if (smartLinks.length === 0) {
    return null;
  }

  return smartLinks[Math.floor(Math.random() * smartLinks.length)] ?? null;
}

export async function sendSponsoredSmartLink(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const smartLink = pickSmartLink(getAvailableSmartLinks());

  if (!smartLink) {
    console.log(
      "[Sponsored] Skipping sponsored message: MONETAG_SMARTLINK_URL and ADSTERRA_SMARTLINK_URL are not set.",
    );
    return;
  }

  try {
    await sendTextMessage(bot, chatId, SPONSORED_MESSAGE, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Learn more",
              url: smartLink.url,
            },
          ],
        ],
      },
    });
    console.log("[Sponsored] SmartLink message sent successfully.", {
      chatId,
      source: smartLink.name,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      "[Sponsored] Skipping sponsored message because the send failed.",
      {
        error: message,
        source: smartLink.name,
      },
    );
    logger.warn(
      { err: message, source: smartLink.name },
      "Skipping sponsored message because SmartLink send failed",
    );
  }
}
