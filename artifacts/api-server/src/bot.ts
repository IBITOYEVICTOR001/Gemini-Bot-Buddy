import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import { tavily, type TavilyClient } from "@tavily/core";
import { PDFParse } from "pdf-parse";
import { search as duckDuckGoSearch } from "duck-duck-scrape";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const OCR_SPACE_API_URL = "https://api.ocr.space/parse/image";
const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai/image/";

// PDF limits
/** Telegram Bot API hard cap for file downloads */
const PDF_MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
/** Characters fed into Groq — keeps prompt within context window */
const PDF_MAX_TEXT_CHARS = 15_000;

const FALLBACK_MESSAGE =
  "Sorry, I ran into a problem reaching my AI brain. Please try again in a moment! 🙏";

/**
 * System prompt for the search-decision step.
 * Must return valid JSON matching SearchDecision.
 */
const SEARCH_DECISION_SYSTEM_PROMPT = `You are a routing assistant. Your only job is to decide whether answering the user's message requires live, up-to-date information from the internet.

Rules:
- If the question is about current events, news, real-time data, prices, sports scores, weather, or anything that changes frequently → needs_search: true
- If the question can be answered accurately from general knowledge or the conversation so far → needs_search: false
- Always provide a concise search_query (≤ 12 words) even when needs_search is false — it will be ignored in that case.

Respond with ONLY a JSON object, no markdown, no explanation:
{"needs_search": boolean, "search_query": string}`;

/**
 * System prompt for the final answer step — defines LadexAIBot's personality and behaviour.
 */
const ANSWER_SYSTEM_PROMPT = `You are LadexAIBot, a helpful, friendly, and knowledgeable AI assistant on Telegram. Follow these principles:

1. Be concise by default. Give clear, direct answers. Only go longer when the question genuinely needs depth (e.g. explanations, tutorials, comparisons).
2. Use natural, conversational language — avoid sounding robotic or overly formal unless the user's tone suggests they want that.
3. When uncertain about a fact, say so clearly rather than guessing confidently. If web search results are available, prioritize those over your own assumptions for anything time-sensitive or fact-dependent.
4. Format responses for readability on a phone screen: short paragraphs, occasional bullet points for lists, avoid giant walls of text.
5. Match the user's energy — if they're casual, be casual; if they're asking something technical or serious, be precise and thorough.
6. If a request is ambiguous, make a reasonable assumption and answer helpfully rather than asking clarifying questions for every little thing — but ask if the ambiguity is significant enough that you can't reasonably guess.
7. Don't over-apologize or add unnecessary disclaimers. Be direct and confident where you have good information.
8. You can generate images (say so if asked "can you make images") and read text from photos sent to you (OCR) — mention these capabilities naturally if relevant, don't force it.`;

/**
 * System prompt used when Groq is asked to reason about OCR-extracted text.
 */
const OCR_ANSWER_SYSTEM_PROMPT = `You are a helpful Telegram chatbot assistant. The user has sent you an image. 
The text extracted from that image via OCR is provided below, followed by the user's question or instruction about it.
Answer clearly and concisely based on the extracted text.`;

/**
 * System prompt used when Groq is asked to reason about PDF text.
 */
const PDF_ANSWER_SYSTEM_PROMPT = `You are LadexAIBot. The user has sent you a PDF document.
The text extracted from the document is provided below.
When answering questions, be accurate and reference relevant parts of the document.
When summarising, be concise — cover the main points in a way that fits a phone screen.
Format for readability: short paragraphs, bullet points for lists.`;

// ---------------------------------------------------------------------------
// Image generation intent detection
// ---------------------------------------------------------------------------

/**
 * Verbs and nouns that signal an image-generation request.
 * Both must appear for the message to be routed to image generation.
 */
const IMAGE_GEN_VERB_RE =
  /\b(generate|draw|create|make|design|render|paint|sketch|produce|show me)\b/i;

const IMAGE_GEN_NOUN_RE =
  /\b(image|picture|photo|illustration|art(?:work)?|painting|portrait|poster|logo|icon|banner|wallpaper|cartoon|drawing|meme|thumbnail|visual|graphic|scene|landscape)\b/i;

/**
 * Returns the cleaned image prompt if the text is an image-generation request,
 * or null if it is a regular chat message.
 */
function extractImageGenPrompt(text: string): string | null {
  if (!IMAGE_GEN_VERB_RE.test(text)) return null;
  // "draw" alone implies an image even without an explicit image noun
  const hasDraw = /\bdraw\b/i.test(text);
  if (!hasDraw && !IMAGE_GEN_NOUN_RE.test(text)) return null;

  // Strip the generation preamble to get just the descriptive subject
  const stripped = text
    .replace(
      /^(generate|draw|create|make|design|render|paint|sketch|produce)\s+(me\s+)?/i,
      "",
    )
    .replace(
      /^(an?\s+)?(image|picture|photo|illustration|art(?:work)?|painting|portrait|poster|logo|icon|banner|wallpaper|cartoon|drawing|meme|thumbnail|visual|graphic|scene|landscape)\s+(of\s+)?/i,
      "",
    )
    .trim();

  return stripped.length > 0 ? stripped : text.trim();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Role = "user" | "assistant";

interface ConversationTurn {
  role: Role;
  content: string;
}

interface SearchDecision {
  needs_search: boolean;
  search_query: string;
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

interface PdfExtractResult {
  text: string;
  pages: number;
  truncated: boolean;
}

interface OcrSpaceParsedResult {
  ParsedText: string;
  ErrorMessage: string;
  ErrorDetails: string;
}

interface OcrSpaceResponse {
  ParsedResults: OcrSpaceParsedResult[];
  OCRExitCode: number;
  IsErroredOnProcessing: boolean;
  ErrorMessage: string | string[] | null;
}

// ---------------------------------------------------------------------------
// Clients — lazily initialised on first use so env-var errors surface clearly
// ---------------------------------------------------------------------------

let groqClient: OpenAI | null = null;
let tavilyClient: TavilyClient | null = null;

function getGroqClient(): OpenAI {
  if (!groqClient) {
    const apiKey = process.env["GROQ_API_KEY"];
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    groqClient = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
  }
  return groqClient;
}

function getTavilyClient(): TavilyClient {
  if (!tavilyClient) {
    const apiKey = process.env["TAVILY_API_KEY"];
    if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
    tavilyClient = tavily({ apiKey });
  }
  return tavilyClient;
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

function appendHistory(chatId: number, role: Role, content: string): void {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — decide whether a web search is needed
// ---------------------------------------------------------------------------

async function decideSearch(
  chatId: number,
  userText: string,
): Promise<SearchDecision> {
  const groq = getGroqClient();

  const historyContext = getHistory(chatId)
    .slice(-4)
    .map((t) => `${t.role === "user" ? "User" : "Bot"}: ${t.content}`)
    .join("\n");

  const contextNote =
    historyContext.length > 0
      ? `\n\nRecent conversation:\n${historyContext}`
      : "";

  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: SEARCH_DECISION_SYSTEM_PROMPT },
      { role: "user", content: `${userText}${contextNote}` },
    ],
    response_format: { type: "json_object" },
    max_tokens: 80,
    temperature: 0,
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `[Router] Failed to parse search decision JSON for chat ${chatId}: ${raw}`,
    );
    return { needs_search: false, search_query: userText };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)["needs_search"] !== "boolean" ||
    typeof (parsed as Record<string, unknown>)["search_query"] !== "string"
  ) {
    console.warn(
      `[Router] Unexpected search decision shape for chat ${chatId}:`,
      parsed,
    );
    return { needs_search: false, search_query: userText };
  }

  const decision = parsed as SearchDecision;
  console.log(
    `[Router] Chat ${chatId} — needs_search: ${decision.needs_search}, query: "${decision.search_query}"`,
  );
  return decision;
}

// ---------------------------------------------------------------------------
// Phase 2 — run multi-engine web search (Tavily + DuckDuckGo)
// ---------------------------------------------------------------------------

/**
 * Fetches results from Tavily.
 * Returns empty array on error instead of crashing.
 */
async function runTavilySearch(query: string): Promise<SearchResult[]> {
  try {
    const client = getTavilyClient();
    const response = await client.search(query, {
      searchDepth: "basic",
      maxResults: 5,
      includeAnswer: false,
    });

    const results: SearchResult[] = (response.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
    }));

    console.log(`[Tavily] "${query}" → ${results.length} result(s)`);
    return results;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Tavily] Search failed for query "${query}": ${msg}`);
    return [];
  }
}

/**
 * Fetches results from DuckDuckGo via duck-duck-scrape.
 * Returns empty array on error instead of crashing.
 */
async function runDuckDuckGoSearch(query: string): Promise<SearchResult[]> {
  try {
    const response = await duckDuckGoSearch(query, { safeSearch: "off" });
    const results: SearchResult[] = (response.results ?? [])
      .slice(0, 5)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: r.description ?? "",
      }));

    console.log(`[DuckDuckGo] "${query}" → ${results.length} result(s)`);
    return results;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[DuckDuckGo] Search failed for query "${query}": ${msg}`);
    return [];
  }
}

/**
 * Runs web search against both Tavily and DuckDuckGo in parallel.
 * Merges and deduplicates results by URL.
 * If one engine fails, proceeds with results from the other.
 */
async function runWebSearch(query: string): Promise<SearchResult[]> {
  // Fire both searches in parallel
  const [tavilyResults, duckDuckGoResults] = await Promise.all([
    runTavilySearch(query),
    runDuckDuckGoSearch(query),
  ]);

  // Merge results and deduplicate by URL
  const merged = [...tavilyResults, ...duckDuckGoResults];
  const seen = new Set<string>();
  const deduplicated: SearchResult[] = [];

  for (const result of merged) {
    if (result.url && !seen.has(result.url)) {
      seen.add(result.url);
      deduplicated.push(result);
    }
  }

  console.log(
    `[WebSearch] Combined results: ${tavilyResults.length} from Tavily + ${duckDuckGoResults.length} from DuckDuckGo = ${deduplicated.length} deduplicated`,
  );

  return deduplicated;
}

// ---------------------------------------------------------------------------
// Phase 3 — ask Groq for the final answer (with optional search context)
// ---------------------------------------------------------------------------

async function getFinalAnswer(
  chatId: number,
  userText: string,
  searchResults: SearchResult[],
): Promise<{ reply: string; sources: string[] }> {
  const groq = getGroqClient();
  const history = getHistory(chatId);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: ANSWER_SYSTEM_PROMPT },
  ];

  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  let effectiveUserContent = userText;
  const sources: string[] = [];

  if (searchResults.length > 0) {
    const searchContext = searchResults
      .map(
        (r, i) =>
          `[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content.slice(0, 600)}`,
      )
      .join("\n\n---\n\n");

    effectiveUserContent =
      `The following live web search results were retrieved for this question. ` +
      `These results are aggregated from multiple search engines (Tavily and DuckDuckGo). ` +
      `Use this cross-checked information to provide an accurate, up-to-date answer. ` +
      `State what they say directly and confidently. ` +
      `Do NOT hedge or express doubt when the results clearly address the question. ` +
      `Only use uncertain language if the results are genuinely vague, contradictory, or don't cover the question.\n\n` +
      `=== LIVE SEARCH RESULTS (Multi-Engine Aggregated) ===\n${searchContext}\n=== END OF RESULTS ===\n\n` +
      `User question: ${userText}`;

    sources.push(...searchResults.map((r) => r.url).filter(Boolean));
  }

  messages.push({ role: "user", content: effectiveUserContent });

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages,
    max_tokens: 1024,
    temperature: 0.5,
  });

  const reply =
    completion.choices[0]?.message?.content?.trim() ||
    "I got an empty response — please try again.";

  console.log(
    `[Groq] Reply for chat ${chatId}: "${reply.slice(0, 120)}${reply.length > 120 ? "…" : ""}"`,
  );

  return { reply, sources };
}

// ---------------------------------------------------------------------------
// Orchestrator — ties the three phases together (existing chat flow)
// ---------------------------------------------------------------------------

async function handleUserMessage(
  chatId: number,
  userText: string,
): Promise<string> {
  appendHistory(chatId, "user", userText);

  const decision = await decideSearch(chatId, userText);

  let searchResults: SearchResult[] = [];
  if (decision.needs_search) {
    try {
      searchResults = await runWebSearch(decision.search_query);
    } catch (searchErr: unknown) {
      const msg =
        searchErr instanceof Error ? searchErr.message : String(searchErr);
      console.error(`[WebSearch] Search failed for chat ${chatId}: ${msg}`);
    }
  }

  const { reply, sources } = await getFinalAnswer(
    chatId,
    userText,
    searchResults,
  );

  let finalReply = reply;
  if (sources.length > 0) {
    const sourceLines = sources
      .slice(0, 5)
      .map((url, i) => `${i + 1}. ${url}`)
      .join("\n");
    finalReply = `${reply}\n\n🔗 Sources:\n${sourceLines}`;
  }

  appendHistory(chatId, "assistant", reply);

  return finalReply;
}

// ---------------------------------------------------------------------------
// NEW: Image generation via Pollinations.ai (no API key required)
// ---------------------------------------------------------------------------

/**
 * Builds a Pollinations.ai image URL and sends the resulting photo to the chat.
 * Pollinations streams the image directly from the URL, so sendPhoto handles it.
 */
async function handleImageGen(
  chatId: number,
  bot: TelegramBot,
  prompt: string,
): Promise<void> {
  // Use a fixed seed derived from current time for reproducible-per-request uniqueness
  const seed = Date.now() % 1_000_000;
  const encodedPrompt = encodeURIComponent(prompt);
  const imageUrl =
    `${POLLINATIONS_BASE_URL}${encodedPrompt}` +
    `?width=1024&height=1024&nologo=true&seed=${seed}`;

  console.log(
    `[ImageGen] Chat ${chatId} — prompt: "${prompt}" | URL: ${imageUrl}`,
  );

  await bot.sendChatAction(chatId, "upload_photo");
  await bot.sendPhoto(chatId, imageUrl, {
    caption: `Here is your image: "${prompt}"`,
  });

  console.log(`[ImageGen] Photo sent to chat ${chatId} ✅`);
}

// ---------------------------------------------------------------------------
// NEW: OCR via OCR.space API
// ---------------------------------------------------------------------------

/**
 * Downloads a Telegram file by its file ID and returns the raw bytes.
 */
async function downloadTelegramFile(
  bot: TelegramBot,
  fileId: string,
): Promise<Buffer> {
  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  if (!res.ok) {
    throw new Error(
      `Failed to download Telegram file: ${res.status} ${res.statusText}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Sends image bytes to OCR.space and returns the extracted text.
 * Throws if the API reports a processing error.
 */
async function runOcr(imageBuffer: Buffer): Promise<string> {
  const apiKey = process.env["OCR_SPACE_API_KEY"];
  if (!apiKey) throw new Error("OCR_SPACE_API_KEY is not set");

  const formData = new FormData();
  formData.append("apikey", apiKey);
  formData.append("language", "eng");
  formData.append("isOverlayRequired", "false");
  formData.append("detectOrientation", "true");
  formData.append("scale", "true");
  formData.append(
    "file",
    new Blob([imageBuffer], { type: "image/jpeg" }),
    "image.jpg",
  );

  console.log(`[OCR] Sending image to OCR.space (${imageBuffer.length} bytes)`);

  const res = await fetch(OCR_SPACE_API_URL, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`OCR.space HTTP error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as OcrSpaceResponse;

  if (data.IsErroredOnProcessing) {
    const msg = Array.isArray(data.ErrorMessage)
      ? data.ErrorMessage.join("; ")
      : (data.ErrorMessage ?? "Unknown OCR error");
    throw new Error(`OCR.space processing error: ${msg}`);
  }

  const extractedText = (data.ParsedResults ?? [])
    .map((r) => r.ParsedText ?? "")
    .join("\n")
    .trim();

  console.log(
    `[OCR] Extracted text (${extractedText.length} chars): "${extractedText.slice(0, 120)}${extractedText.length > 120 ? "…" : ""}"`,
  );

  return extractedText;
}

/**
 * Full handler for photo messages:
 * 1. Downloads the photo from Telegram.
 * 2. Extracts text via OCR.space.
 * 3. If the message has a caption, passes both the OCR text and caption to Groq.
 * 4. Otherwise sends the raw extracted text back to the user.
 */
async function handlePhotoMessage(
  chatId: number,
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const photos = msg.photo;
  if (!photos || photos.length === 0) return;

  // Pick the highest-resolution version Telegram provides
  const fileId = photos[photos.length - 1]!.file_id;
  const caption = msg.caption?.trim() ?? "";

  console.log(
    `[OCR] Photo received in chat ${chatId}${caption ? ` with caption: "${caption}"` : " (no caption)"}`,
  );

  await bot.sendChatAction(chatId, "typing");

  let extractedText: string;
  try {
    const imageBuffer = await downloadTelegramFile(bot, fileId);
    extractedText = await runOcr(imageBuffer);
  } catch (ocrErr: unknown) {
    const msg2 = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
    console.error(`[OCR] Failed for chat ${chatId}: ${msg2}`);
    await bot.sendMessage(
      chatId,
      "Sorry, I could not extract text from that image. Please make sure the image contains clear, readable text and try again.",
    );
    return;
  }

  if (!extractedText) {
    await bot.sendMessage(
      chatId,
      "I could not find any readable text in that image.",
    );
    return;
  }

  // If the user attached a caption (question/instruction), route to Groq
  if (caption.length > 0) {
    const groq = getGroqClient();
    const userContent = `OCR extracted text:\n"""\n${extractedText}\n"""\n\nUser instruction: ${caption}`;

    console.log(
      `[OCR] Caption detected — passing extracted text + caption to Groq for chat ${chatId}`,
    );

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: OCR_ANSWER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 1024,
      temperature: 0.5,
    });

    const groqReply =
      completion.choices[0]?.message?.content?.trim() ||
      "I could not generate a response about the image content.";

    console.log(
      `[OCR+Groq] Reply for chat ${chatId}: "${groqReply.slice(0, 120)}${groqReply.length > 120 ? "…" : ""}"`,
    );

    // Store as a conversational turn so the context carries forward
    appendHistory(chatId, "user", `[Image OCR] ${caption}`);
    appendHistory(chatId, "assistant", groqReply);

    const safe =
      groqReply.length > 4000
        ? groqReply.slice(0, 4000) + "\n\n…(truncated)"
        : groqReply;
    await bot.sendMessage(chatId, safe);
  } else {
    // No caption — just return the raw extracted text
    const header = "📄 Text extracted from your image:\n\n";
    const body =
      extractedText.length > 3900
        ? extractedText.slice(0, 3900) + "\n\n…(truncated)"
        : extractedText;
    await bot.sendMessage(chatId, header + body);
  }

  console.log(`[OCR] Response sent to chat ${chatId} ✅`);
}

// ---------------------------------------------------------------------------
// NEW: PDF text extraction via pdf-parse v2
// ---------------------------------------------------------------------------

/**
 * Parses a PDF buffer and returns the extracted text, page count, and whether
 * the text was truncated to fit within PDF_MAX_TEXT_CHARS.
 */
async function runPdfExtract(buffer: Buffer): Promise<PdfExtractResult> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const raw = result.text.trim();
    const truncated = raw.length > PDF_MAX_TEXT_CHARS;
    const text = truncated ? raw.slice(0, PDF_MAX_TEXT_CHARS) : raw;

    console.log(
      `[PDF] Extracted ${raw.length} chars across ${result.total} page(s)` +
        (truncated ? ` — truncated to ${PDF_MAX_TEXT_CHARS} chars for Groq` : ""),
    );

    return { text, pages: result.total, truncated };
  } finally {
    await parser.destroy();
  }
}

/**
 * Sends a long text reply across multiple Telegram messages if it exceeds
 * the 4 000-character per-message limit.
 */
async function sendLongMessage(
  bot: TelegramBot,
  chatId: number,
  text: string,
): Promise<void> {
  const CHUNK = 4000;
  if (text.length <= CHUNK) {
    await bot.sendMessage(chatId, text);
    return;
  }
  let offset = 0;
  let part = 1;
  const total = Math.ceil(text.length / CHUNK);
  while (offset < text.length) {
    const slice = text.slice(offset, offset + CHUNK);
    await bot.sendMessage(chatId, `[Part ${part}/${total}]\n\n${slice}`);
    offset += CHUNK;
    part++;
  }
}

/**
 * Full handler for PDF document messages:
 * 1. Guards file-size and mime-type.
 * 2. Downloads the file from Telegram.
 * 3. Extracts text with pdf-parse.
 * 4. If a caption is present → Groq Q&A. Otherwise → Groq auto-summary.
 */
async function handleDocumentMessage(
  chatId: number,
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const doc = msg.document!;
  const caption = msg.caption?.trim() ?? "";
  const fileName = doc.file_name ?? "document.pdf";
  const fileSize = doc.file_size ?? 0;

  console.log(
    `[PDF] Document received in chat ${chatId} — file: "${fileName}", ` +
      `size: ${(fileSize / 1024).toFixed(1)} KB` +
      (caption ? `, caption: "${caption}"` : ", no caption"),
  );

  // Guard: only handle PDFs
  const isPdf =
    doc.mime_type === "application/pdf" ||
    fileName.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    await bot.sendMessage(
      chatId,
      "I can only read PDF files right now. Send me a .pdf document and I'll extract and analyse its text.",
    );
    return;
  }

  // Guard: Telegram's Bot API download cap
  if (fileSize > PDF_MAX_FILE_BYTES) {
    await bot.sendMessage(
      chatId,
      `That PDF is ${(fileSize / 1024 / 1024).toFixed(1)} MB, which exceeds the 20 MB download limit. ` +
        "Please send a smaller file.",
    );
    return;
  }

  await bot.sendChatAction(chatId, "typing");

  // Download
  let buffer: Buffer;
  try {
    buffer = await downloadTelegramFile(bot, doc.file_id);
  } catch (dlErr: unknown) {
    const m = dlErr instanceof Error ? dlErr.message : String(dlErr);
    console.error(`[PDF] Download failed for chat ${chatId}: ${m}`);
    await bot.sendMessage(
      chatId,
      "I couldn't download that file. Please try again.",
    );
    return;
  }

  // Extract text
  let extracted: PdfExtractResult;
  try {
    extracted = await runPdfExtract(buffer);
  } catch (parseErr: unknown) {
    const m = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error(`[PDF] Parsing failed for chat ${chatId}: ${m}`);
    await bot.sendMessage(
      chatId,
      "I couldn't read that PDF — it may be scanned, password-protected, or corrupt. " +
        "For scanned PDFs, try sending the image directly so I can OCR it.",
    );
    return;
  }

  if (!extracted.text) {
    await bot.sendMessage(
      chatId,
      "The PDF appears to contain no extractable text. " +
        "If it's a scanned document, send the pages as images instead.",
    );
    return;
  }

  const groq = getGroqClient();
  const truncationNote = extracted.truncated
    ? `\n\n(Note: the document is very long. Only the first ${PDF_MAX_TEXT_CHARS.toLocaleString()} characters were analysed.)`
    : "";

  if (caption.length > 0) {
    // Q&A mode — user asked something specific about the document
    console.log(
      `[PDF] Caption present — routing to Groq Q&A for chat ${chatId}`,
    );

    const userContent =
      `PDF document: "${fileName}" (${extracted.pages} page(s))\n\n` +
      `=== DOCUMENT TEXT ===\n${extracted.text}\n=== END ===\n\n` +
      `User question: ${caption}`;

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: PDF_ANSWER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 1024,
      temperature: 0.5,
    });

    const groqReply =
      completion.choices[0]?.message?.content?.trim() ||
      "I couldn't generate an answer. Please try again.";

    console.log(
      `[PDF+Groq] Q&A reply for chat ${chatId}: "${groqReply.slice(0, 120)}${groqReply.length > 120 ? "…" : ""}"`,
    );

    appendHistory(chatId, "user", `[PDF "${fileName}"] ${caption}`);
    appendHistory(chatId, "assistant", groqReply);

    await sendLongMessage(bot, chatId, groqReply + truncationNote);
  } else {
    // No caption — auto-summarise
    console.log(
      `[PDF] No caption — requesting Groq auto-summary for chat ${chatId}`,
    );

    const userContent =
      `PDF document: "${fileName}" (${extracted.pages} page(s))\n\n` +
      `=== DOCUMENT TEXT ===\n${extracted.text}\n=== END ===\n\n` +
      `Please give a clear, concise summary of this document. ` +
      `Cover the main topics, key points, and any important conclusions or data.`;

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: PDF_ANSWER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 1024,
      temperature: 0.5,
    });

    const groqReply =
      completion.choices[0]?.message?.content?.trim() ||
      "I couldn't generate a summary. Please try again.";

    console.log(
      `[PDF+Groq] Summary reply for chat ${chatId}: "${groqReply.slice(0, 120)}${groqReply.length > 120 ? "…" : ""}"`,
    );

    appendHistory(chatId, "user", `[PDF "${fileName}"] summarise`);
    appendHistory(chatId, "assistant", groqReply);

    const header = `📄 Summary of "${fileName}" (${extracted.pages} page(s)):\n\n`;
    await sendLongMessage(bot, chatId, header + groqReply + truncationNote);
  }

  console.log(`[PDF] Response sent to chat ${chatId} ✅`);
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

  const tavilyKey = process.env["TAVILY_API_KEY"];
  if (!tavilyKey) {
    console.warn(
      "[Bot] TAVILY_API_KEY is not set — web search will be limited to DuckDuckGo only.",
    );
  }

  const ocrKey = process.env["OCR_SPACE_API_KEY"];
  if (!ocrKey) {
    console.warn(
      "[Bot] OCR_SPACE_API_KEY is not set — image OCR will be disabled.",
    );
  }

  console.log("[Bot] GROQ_API_KEY defined: true");
  console.log(`[Bot] TAVILY_API_KEY defined: ${Boolean(tavilyKey)}`);
  console.log(`[Bot] OCR_SPACE_API_KEY defined: ${Boolean(ocrKey)}`);
  console.log(
    "[Bot] Web search: enabled (multi-engine: Tavily + DuckDuckGo with fallback)",
  );
  console.log("[Bot] Image generation: enabled (Pollinations.ai, no key needed)");
  console.log("[Bot] PDF reading: enabled (pdf-parse, no key needed)");
  console.log(`[Bot] Model: ${GROQ_MODEL}`);

  const bot = new TelegramBot(token, { polling: true });
  console.log("[Bot] Telegram bot started with long polling ✅");

  // ------------------------------------------------------------------
  // PDF document messages → extract + summarise / Q&A
  // ------------------------------------------------------------------
  bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    const senderName =
      msg.from?.username ??
      (`${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim() ||
        String(chatId));

    console.log(
      `[Telegram] Document received from @${senderName} (chat ${chatId}): "${msg.document?.file_name ?? "unknown"}"`,
    );

    try {
      await handleDocumentMessage(chatId, bot, msg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] PDF flow error for chat ${chatId}: ${message}`);
      console.error("[Bot] Full error:", err);
      try {
        await bot.sendMessage(chatId, FALLBACK_MESSAGE);
      } catch (sendErr) {
        console.error(
          `[Bot] Failed to send fallback to chat ${chatId}:`,
          sendErr,
        );
      }
    }
  });

  // ------------------------------------------------------------------
  // Photo messages → OCR flow
  // ------------------------------------------------------------------
  bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    const senderName =
      msg.from?.username ??
      (`${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim() ||
        String(chatId));

    console.log(
      `[Telegram] Photo received from @${senderName} (chat ${chatId})`,
    );

    if (!process.env["OCR_SPACE_API_KEY"]) {
      await bot.sendMessage(
        chatId,
        "OCR is not configured on this bot right now. Please contact the bot owner.",
      );
      return;
    }

    try {
      await handlePhotoMessage(chatId, bot, msg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Bot] OCR flow error for chat ${chatId}: ${message}`);
      try {
        await bot.sendMessage(chatId, FALLBACK_MESSAGE);
      } catch (sendErr) {
        console.error(
          `[Bot] Failed to send fallback to chat ${chatId}:`,
          sendErr,
        );
      }
    }
  });

  // ------------------------------------------------------------------
  // Text messages → image generation OR existing chat/search flow
  // ------------------------------------------------------------------
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userText = msg.text;

    // Skip non-text messages (photos are handled by the "photo" listener above)
    if (!userText) return;

    const senderName =
      msg.from?.username ??
      (`${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim() ||
        String(chatId));

    console.log(
      `[Telegram] Message from @${senderName} (chat ${chatId}): "${userText}"`,
    );

    try {
      // Route: image generation intent?
      const imagePrompt = extractImageGenPrompt(userText);

      if (imagePrompt !== null) {
        console.log(
          `[Router] Chat ${chatId} — intent: IMAGE_GEN, prompt: "${imagePrompt}"`,
        );
        await handleImageGen(chatId, bot, imagePrompt);
        return;
      }

      // Route: regular chat + optional web search
      console.log(`[Router] Chat ${chatId} — intent: CHAT`);
      const reply = await handleUserMessage(chatId, userText);

      const safe =
        reply.length > 4000 ? reply.slice(0, 4000) + "\n\n…(truncated)" : reply;

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
      } catch (sendErr) {
        console.error(
          `[Bot] Failed to send fallback to chat ${chatId}:`,
          sendErr,
        );
      }
    }
  });

  bot.on("polling_error", (err) => {
    console.error("[Bot] Polling error:", err.message);
  });
}
