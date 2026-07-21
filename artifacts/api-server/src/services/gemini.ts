import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

export type SearchResult = {
  title: string;
  url: string;
  content: string;
};

const GEMINI_MODEL = process.env["GEMINI_MODEL"] ?? "gemini-1.5-pro";

let geminiClient: OpenAI | null = null;

function getGeminiClient(): OpenAI {
  if (!geminiClient) {
    const apiKey = process.env["GEMINI_API_KEY"];
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    geminiClient = new OpenAI({ apiKey });
  }
  return geminiClient;
}

const CORE_INTELLIGENCE_SYSTEM_PROMPT = `You are a versatile AI assistant for conversational chat, teaching, research framing, creativity, project ideation, games, translation, clean code generation, and data analytics.
Use simple, easy-to-understand explanations when defining concepts or breaking down complex topics.
When writing stories, poems, dialogues, or project ideas, be original and imaginative.
When asked to translate, detect the user's input language and return an accurate result in the requested target language.
When asked to generate code or scripts, produce clean, runnable solutions and include minimal explanatory context only when the user requests it.
When asked to analyse numbers, statistics, or datasets, identify key patterns and explain what the numbers mean for a real user.
When asked for a text-based game, produce a playable round of Hangman, 20 Questions, or Word Jumble, including clear rules and a starting state.`;

async function geminiChat(
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number },
): Promise<string> {
  const client = getGeminiClient();

  const completion = await client.chat.completions.create({
    model: GEMINI_MODEL,
    messages,
    max_tokens: options?.maxTokens ?? 1024,
    temperature: options?.temperature ?? 0.7,
  });

  const content = completion.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Gemini returned an empty response.");
  }
  return content;
}

export async function decideSearch(
  userText: string,
  history: ChatMessage[] = [],
): Promise<SearchDecision> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a search router. Decide whether the user query needs live, up-to-date web research to answer accurately. Respond with valid JSON only, no additional text.
Return exactly:
{"needs_search": boolean, "search_query": string}`,
    },
    ...history,
    {
      role: "user",
      content: userText,
    },
  ];

  const raw = await geminiChat(messages, { maxTokens: 80, temperature: 0.0 });

  try {
    const parsed = JSON.parse(raw) as SearchDecision;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.needs_search === "boolean" &&
      typeof parsed.search_query === "string"
    ) {
      return parsed;
    }
  } catch {
    // fall through to default below
  }

  return { needs_search: false, search_query: userText };
}

export async function generateConversationReply(
  userText: string,
  history: ChatMessage[] = [],
  searchResults: SearchResult[] = [],
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: CORE_INTELLIGENCE_SYSTEM_PROMPT,
    },
    ...history,
  ];

  let effectiveUserText = userText;

  if (searchResults.length > 0) {
    const resultText = searchResults
      .slice(0, 5)
      .map(
        (result, index) =>
          `[Source ${index + 1}] ${result.title}\nURL: ${result.url}\n${result.content.slice(
            0,
            600,
          )}`,
      )
      .join("\n\n---\n\n");

    effectiveUserText =
      `The user asked: ${userText}\n\n` +
      `Use the following real-time findings to answer the question accurately. ` +
      `When the results are directly relevant, cite them briefly. ` +
      `If they are not relevant, rely on your broader knowledge and say so.

` +
      `=== LIVE RESEARCH RESULTS ===\n${resultText}\n=== END OF RESULTS ===`;
  }

  messages.push({ role: "user", content: effectiveUserText });
  return geminiChat(messages, { maxTokens: 1024, temperature: 0.65 });
}

export async function generateTranslation(
  text: string,
  targetLanguage = "English",
): Promise<string> {
  const prompt =
    `Translate the following text into ${targetLanguage}. Keep the meaning, tone, and context accurate. ` +
    `If the input is already in ${targetLanguage}, confirm that and return the original text.

Text:\n"""${text}"""`;

  return geminiChat([
    { role: "system", content: CORE_INTELLIGENCE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);
}

export async function generateCreativeOutput(
  creativeType: "story" | "poem" | "dialogue" | "projectIdeas",
  topic: string,
): Promise<string> {
  const creativeInstructions: Record<string, string> = {
    story: `Write an original short story about ${topic}. Use vivid detail, a clear beginning, middle, and end, and keep the language easy to follow.`,
    poem: `Write an original poem about ${topic}. Use poetic imagery, rhythm, and emotion. Keep it concise and engaging.`,
    dialogue: `Write a dialogue between two characters about ${topic}. Make the voices distinct and the exchange natural.`,
    projectIdeas: `Generate five practical project ideas related to ${topic}. For each idea, give a one-sentence summary and one reason why it is interesting to build.`,
  };

  const prompt = creativeInstructions[creativeType];
  return geminiChat([
    { role: "system", content: CORE_INTELLIGENCE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);
}

export async function generateGame(
  gameType: "hangman" | "20questions" | "wordjumble",
  subject: string,
): Promise<string> {
  const normalized = gameType.toLowerCase();
  let prompt = "";

  if (normalized === "hangman") {
    prompt =
      `Create a playable Hangman puzzle using the subject: ${subject}. ` +
      `Provide the word or phrase as blanks, list the rules, and include the first guess prompt. ` +
      `Do not reveal the answer.`;
  } else if (normalized === "20questions") {
    prompt =
      `Start a 20 Questions game using the theme: ${subject}. ` +
      `Explain the rules, think of a secret answer, and invite the user to ask yes/no questions.`;
  } else if (normalized === "wordjumble") {
    prompt =
      `Create a Word Jumble puzzle using the subject: ${subject}. ` +
      `Provide the scrambled word, a short clue, and instructions for how the player should solve it.`;
  } else {
    prompt =
      `Create a simple text-based game using the subject: ${subject}. ` +
      `Keep it fun and easy to play with one short message.`;
  }

  return geminiChat([
    { role: "system", content: CORE_INTELLIGENCE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);
}

export async function generateCodeSnippet(
  request: string,
  language = "JavaScript",
): Promise<string> {
  const prompt =
    `Create a clean, runnable ${language} code sample or script for the following request:\n` +
    `${request}\n\n` +
    `If a complete script is appropriate, include any required imports and a short usage note. ` +
    `Keep comments minimal and focus on readability.`;

  return geminiChat([
    { role: "system", content: CORE_INTELLIGENCE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);
}

export async function analyzeDataset(
  data: unknown,
  question: string,
): Promise<string> {
  const payload =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

  const prompt =
    `You are a data analyst. Review the dataset below and answer the question clearly and directly. ` +
    `If there are numerical patterns or anomalies, explain them and provide practical insights.

Dataset:\n${payload}\n\nQuestion: ${question}`;

  return geminiChat([
    { role: "system", content: CORE_INTELLIGENCE_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);
}
