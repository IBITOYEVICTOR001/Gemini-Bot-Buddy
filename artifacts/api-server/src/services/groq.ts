import OpenAI from "openai";

// --- Types ---
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type SearchDecision = {
  needs_search: boolean;
  search_query: string;
};

export type SearchResult = {
  title: string;
  url: string;
  content: string;
};

// --- Client & Model Setup ---
const apiKey = process.env.GROQ_API_KEY || "";
const baseURL = "https://api.groq.com/openai/v1";

const groq = new OpenAI({
  apiKey,
  baseURL,
});

const rawModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
export const GROQ_MODEL = rawModel;

// --- Core System Prompts ---
const CORE_INTELLIGENCE_SYSTEM_PROMPT = `You are Ladex AI, an exceptionally smart, friendly, and versatile AI assistant. 
Your primary goal is to assist users with accurate information, creative problem-solving, and clear explanations.
Always be concise, engaging, and directly address the user's request.`;

const CREATIVE_SYSTEM_PROMPTS: Record<string, string> = {
  story: `You are Ladex AI's Creative Engine. Write an engaging, vivid short story based on the user's topic.`,
  poem: `You are Ladex AI's Creative Engine. Write an expressive, vivid poem based on the user's topic.`,
  dialogue: `You are Ladex AI's Creative Engine. Write an engaging dialogue/script scene based on the user's topic.`,
  projectIdeas: `You are Ladex AI's Creative Engine. Brainstorm a clear, practical list of project ideas based on the user's topic.`,
};

const GAME_SYSTEM_PROMPTS: Record<string, string> = {
  hangman: `You are Ladex AI Game Master. Start a text-based Hangman game using the given subject as the secret word/phrase. Show blanks and guide the player.`,
  "20questions": `You are Ladex AI Game Master. Start a text-based 20 Questions game where the given subject is the answer. Let the player ask yes/no questions.`,
  wordjumble: `You are Ladex AI Game Master. Create a word jumble puzzle from the given subject and prompt the player to unscramble it.`,
};

const CODE_SYSTEM_PROMPT = `You are Ladex AI's Expert Software Engineer.
Provide clean, idiomatic, well-commented code solutions in the requested language.
Explain technical concepts simply and highlight best practices.`;

const TRANSLATION_SYSTEM_PROMPT = `You are Ladex AI's Translation & Localization Expert.
Translate the user input accurately into the requested target language while preserving tone, cultural nuances, and context.`;

const DATASET_SYSTEM_PROMPT = `You are Ladex AI's Data Analyst.
Analyze the provided dataset or structured data carefully. Summarize key insights, trends, statistical distributions, and potential anomalies clearly.`;

const SEARCH_DECISION_SYSTEM_PROMPT = `You are a search decision assistant. Analyze the latest user message in context. Respond ONLY in valid JSON format: {"needs_search": true/false, "search_query": "query if search needed else empty"}`;

// --- Core Chat Execution Function ---
export async function groqChat(
  messages: ChatMessage[],
  searchResults?: SearchResult[]
): Promise<string> {
  try {
    const formattedMessages: ChatMessage[] = [...messages];

    if (searchResults && searchResults.length > 0) {
      const context = searchResults
        .map((r) => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`)
        .join("\n\n");
      formattedMessages.push({
        role: "system",
        content: `Web Search Context:\n${context}`,
      });
    }

    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: formattedMessages,
    });

    return response.choices[0]?.message?.content || "No response generated.";
  } catch (error) {
    console.error("Error in groqChat:", error);
    throw error;
  }
}

// --- Conversation reply (matches bot.ts: userText, history, searchResults) ---
export async function generateConversationReply(
  userText: string,
  history: ChatMessage[],
  searchResults?: SearchResult[]
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: CORE_INTELLIGENCE_SYSTEM_PROMPT },
    ...(history.length > 0 ? history : [{ role: "user" as const, content: userText }]),
  ];
  return groqChat(messages, searchResults);
}

// --- Search decision (matches bot.ts: userText, history) ---
export async function decideSearch(
  userText: string,
  history: ChatMessage[] = []
): Promise<SearchDecision> {
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SEARCH_DECISION_SYSTEM_PROMPT },
      ...(history.length > 0 ? history : [{ role: "user" as const, content: userText }]),
    ];

    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    return {
      needs_search: Boolean(parsed.needs_search),
      search_query: parsed.search_query || "",
    };
  } catch (error) {
    console.error("Error in decideSearch:", error);
    return { needs_search: false, search_query: "" };
  }
}

// --- Creative output (matches bot.ts: type, topic) ---
export async function generateCreativeOutput(
  type: "story" | "poem" | "dialogue" | "projectIdeas",
  topic: string
): Promise<string> {
  const systemPrompt = CREATIVE_SYSTEM_PROMPTS[type] ?? CREATIVE_SYSTEM_PROMPTS.story;
  return groqChat([
    { role: "system", content: systemPrompt },
    { role: "user", content: topic },
  ]);
}

// --- Game generation (matches bot.ts: gameType, subject) ---
export async function generateGame(
  gameType: "hangman" | "20questions" | "wordjumble",
  subject: string
): Promise<string> {
  const systemPrompt = GAME_SYSTEM_PROMPTS[gameType] ?? GAME_SYSTEM_PROMPTS.hangman;
  return groqChat([
    { role: "system", content: systemPrompt },
    { role: "user", content: subject },
  ]);
}

// --- Code snippet (matches bot.ts: prompt, language) ---
export async function generateCodeSnippet(
  prompt: string,
  language: string
): Promise<string> {
  return groqChat([
    { role: "system", content: `${CODE_SYSTEM_PROMPT} Requested language: ${language}.` },
    { role: "user", content: prompt },
  ]);
}

// --- Translation (matches bot.ts: text, targetLanguage) ---
export async function generateTranslation(
  text: string,
  targetLanguage: string
): Promise<string> {
  return groqChat([
    { role: "system", content: `${TRANSLATION_SYSTEM_PROMPT} Target Language: ${targetLanguage}` },
    { role: "user", content: text },
  ]);
}

// --- Dataset analysis (matches bot.ts: data) ---
export async function analyzeDataset(data: string): Promise<string> {
  return groqChat([
    { role: "system", content: DATASET_SYSTEM_PROMPT },
    { role: "user", content: data },
  ]);
}
