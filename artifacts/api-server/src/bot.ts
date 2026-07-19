import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import { tavily, type TavilyClient } from "@tavily/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10; // max conversation turns kept per user
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

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
 * System prompt for the final answer step.
 */
const ANSWER_SYSTEM_PROMPT = `You are a knowledgeable, helpful, and concise Telegram chatbot assistant. 
Respond in the same language the user writes in.
Be direct and informative. Avoid unnecessary padding.
When search results are provided, use them to give accurate, up-to-date answers and acknowledge they come from live sources.`;

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

  // Include recent history as context so the router can judge relevance
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
// Phase 2 — run Tavily web search
// ---------------------------------------------------------------------------

async function runWebSearch(query: string): Promise<SearchResult[]> {
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

  // Build the OpenAI-compatible messages array
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: ANSWER_SYSTEM_PROMPT },
  ];

  // Inject conversation history (everything except the current turn)
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // If we have search results, prepend them to the user's message
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
      `The following live web search results were retrieved to help you answer. ` +
      `Use them to give an accurate, up-to-date response.\n\n` +
      `=== SEARCH RESULTS ===\n${searchContext}\n=== END OF RESULTS ===\n\n` +
      `User question: ${userText}`;

    sources.push(...searchResults.map((r) => r.url).filter(Boolean));
  }

  messages.push({ role: "user", content: effectiveUserContent });

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages,
    max_tokens: 1024,
    temperature: 0.7,
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
// Orchestrator — ties the three phases together
// ---------------------------------------------------------------------------

async function handleUserMessage(
  chatId: number,
  userText: string,
): Promise<string> {
  // Record the user turn before any async work
  appendHistory(chatId, "user", userText);

  // Phase 1: routing decision
  const decision = await decideSearch(chatId, userText);

  // Phase 2: optional web search
  let searchResults: SearchResult[] = [];
  if (decision.needs_search) {
    try {
      searchResults = await runWebSearch(decision.search_query);
    } catch (searchErr: unknown) {
      const msg =
        searchErr instanceof Error ? searchErr.message : String(searchErr);
      console.error(`[Tavily] Search failed for chat ${chatId}: ${msg}`);
      // Proceed without search results — graceful degradation
    }
  }

  // Phase 3: final answer
  const { reply, sources } = await getFinalAnswer(
    chatId,
    userText,
    searchResults,
  );

  // Append sources block when available (plain text — no Markdown parse_mode)
  let finalReply = reply;
  if (sources.length > 0) {
    const sourceLines = sources
      .slice(0, 5)
      .map((url, i) => `${i + 1}. ${url}`)
      .join("\n");
    finalReply = `${reply}\n\n🔗 Sources:\n${sourceLines}`;
  }

  // Record the assistant turn in history (without the source footer)
  appendHistory(chatId, "assistant", reply);

  return finalReply;
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
      "[Bot] TAVILY_API_KEY is not set — web search will be disabled.",
    );
  }

  console.log("[Bot] GROQ_API_KEY defined: true");
  console.log(`[Bot] TAVILY_API_KEY defined: ${Boolean(tavilyKey)}`);
  console.log(`[Bot] Model: ${GROQ_MODEL}`);

  const bot = new TelegramBot(token, { polling: true });
  console.log("[Bot] Telegram bot started with long polling ✅");

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userText = msg.text;
    const senderName =
      msg.from?.username ??
      (`${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim() ||
        String(chatId));

    if (!userText) return;

    console.log(
      `[Telegram] Message from @${senderName} (chat ${chatId}): "${userText}"`,
    );

    try {
      const reply = await handleUserMessage(chatId, userText);

      // Telegram hard-limits messages to 4096 chars
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
