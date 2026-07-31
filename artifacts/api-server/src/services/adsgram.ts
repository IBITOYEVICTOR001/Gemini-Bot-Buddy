import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

const ADSGRAM_ENDPOINT = "https://api.adsgram.ai/advbot";
const ADSGRAM_BLOCK_ID = "40636";
const ADSGRAM_LANGUAGE = "en";

interface AdsGramResponse {
  text_html?: string;
  click_url?: string;
  button_name?: string;
  image_url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAdsGramResponse(data: unknown): AdsGramResponse | null {
  const candidates: unknown[] = [];

  if (Array.isArray(data)) {
    candidates.push(...data);
  } else if (isRecord(data)) {
    candidates.push(data, data["ad"], data["data"], data["result"]);
  }

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;

    const ad: AdsGramResponse = {
      text_html: typeof candidate["text_html"] === "string" ? candidate["text_html"] : undefined,
      click_url: typeof candidate["click_url"] === "string" ? candidate["click_url"] : undefined,
      button_name: typeof candidate["button_name"] === "string" ? candidate["button_name"] : undefined,
      image_url: typeof candidate["image_url"] === "string" ? candidate["image_url"] : undefined,
    };

    if (hasAdContent(ad)) return ad;
  }

  return null;
}

function hasAdContent(ad: AdsGramResponse): boolean {
  return Boolean(ad.text_html || ad.click_url || ad.image_url);
}

function buildInlineKeyboard(ad: AdsGramResponse): { inline_keyboard: Array<Array<{ text: string; url: string }>> } | undefined {
  if (!ad.click_url) return undefined;

  return {
    inline_keyboard: [
      [
        {
          text: ad.button_name?.trim() || "Learn more",
          url: ad.click_url,
        },
      ],
    ],
  };
}

function buildSponsoredText(ad: AdsGramResponse): string {
  const adText = ad.text_html?.trim();
  return adText ? `📢 Sponsored\n\n${adText}` : "📢 Sponsored";
}

async function fetchAdsGramAd(userId: number): Promise<AdsGramResponse | null> {
  const token = process.env["ADSGRAM_TOKEN"];
  if (!token) {
    console.log("[AdsGram] Skipping ad fetch: ADSGRAM_TOKEN is not set.");
    return null;
  }

  const url = new URL(ADSGRAM_ENDPOINT);
  url.searchParams.set("tgid", String(userId));
  url.searchParams.set("blockid", ADSGRAM_BLOCK_ID);
  url.searchParams.set("language", ADSGRAM_LANGUAGE);
  url.searchParams.set("token", token);

  console.log("[AdsGram] Calling AdsGram API.", {
    endpoint: ADSGRAM_ENDPOINT,
    tgid: userId,
    blockid: ADSGRAM_BLOCK_ID,
    language: ADSGRAM_LANGUAGE,
    hasToken: true,
  });

  const response = await fetch(url);
  console.log("[AdsGram] AdsGram API response status.", {
    status: response.status,
    statusText: response.statusText,
  });

  if (!response.ok) {
    const body = await response.text();
    console.log("[AdsGram] AdsGram API returned a non-OK response.", { body });
    throw new Error(`AdsGram API returned ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as unknown;
  console.log("[AdsGram] AdsGram API response body.", data);

  const ad = normalizeAdsGramResponse(data);
  if (!ad) {
    console.log("[AdsGram] Skipping ad send: API response did not contain usable ad content.");
    return null;
  }

  return ad;
}

export async function sendSponsoredAd(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  try {
    const ad = await fetchAdsGramAd(userId);
    if (!ad) return;

    const replyMarkup = buildInlineKeyboard(ad);
    const sponsoredText = buildSponsoredText(ad);

    console.log("[AdsGram] Sending sponsored ad to Telegram.", {
      chatId,
      userId,
      hasImage: Boolean(ad.image_url),
      hasButton: Boolean(ad.click_url),
      buttonName: ad.button_name,
    });

    if (ad.image_url) {
      await bot.sendPhoto(chatId, ad.image_url, {
        caption: sponsoredText.slice(0, 1024),
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });
      console.log("[AdsGram] Sponsored photo ad sent successfully.", { chatId, userId });
      return;
    }

    await bot.sendMessage(chatId, sponsoredText, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
    console.log("[AdsGram] Sponsored text ad sent successfully.", { chatId, userId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("[AdsGram] Skipping sponsored ad because the ad flow failed.", { error: message });
    logger.warn({ err: message }, "Skipping sponsored ad because AdsGram request failed");
  }
}
