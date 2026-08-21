import * as groq from "./groq";
import type { ChatMessage, SearchDecision, SearchResult } from "./groq";

export type { ChatMessage, SearchDecision, SearchResult };

type AiProviderName = "groq";
type CreativeType = "story" | "poem" | "dialogue" | "projectIdeas";
type GameType = "hangman" | "20questions" | "wordjumble";

type AiProvider = {
  chat: (messages: ChatMessage[], searchResults?: SearchResult[]) => Promise<string>;
  generateConversationReply: (
    userText: string,
    history: ChatMessage[],
    searchResults?: SearchResult[],
  ) => Promise<string>;
  decideSearch: (userText: string, history?: ChatMessage[]) => Promise<SearchDecision>;
  generateCreativeOutput: (type: CreativeType, topic: string) => Promise<string>;
  generateGame: (gameType: GameType, subject: string) => Promise<string>;
  generateCodeSnippet: (prompt: string, language: string) => Promise<string>;
  generateTranslation: (text: string, targetLanguage: string) => Promise<string>;
  analyzeDataset: (data: string) => Promise<string>;
};

const providers: Record<AiProviderName, AiProvider> = {
  groq: {
    chat: groq.groqChat,
    generateConversationReply: groq.generateConversationReply,
    decideSearch: groq.decideSearch,
    generateCreativeOutput: groq.generateCreativeOutput,
    generateGame: groq.generateGame,
    generateCodeSnippet: groq.generateCodeSnippet,
    generateTranslation: groq.generateTranslation,
    analyzeDataset: groq.analyzeDataset,
  },
};

export function getAiProviderName(): AiProviderName {
  const configuredProvider = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (configuredProvider && configuredProvider !== "groq") {
    console.warn(`Unsupported AI_PROVIDER=${configuredProvider}; using groq.`);
  }

  return "groq";
}

export function getAiProvider(): AiProvider {
  return providers[getAiProviderName()];
}

export async function aiChat(
  messages: ChatMessage[],
  searchResults?: SearchResult[],
): Promise<string> {
  return getAiProvider().chat(messages, searchResults);
}

export async function generateConversationReply(
  userText: string,
  history: ChatMessage[],
  searchResults?: SearchResult[],
): Promise<string> {
  return getAiProvider().generateConversationReply(userText, history, searchResults);
}

export async function decideSearch(
  userText: string,
  history: ChatMessage[] = [],
): Promise<SearchDecision> {
  return getAiProvider().decideSearch(userText, history);
}

export async function generateCreativeOutput(
  type: CreativeType,
  topic: string,
): Promise<string> {
  return getAiProvider().generateCreativeOutput(type, topic);
}

export async function generateGame(gameType: GameType, subject: string): Promise<string> {
  return getAiProvider().generateGame(gameType, subject);
}

export async function generateCodeSnippet(
  prompt: string,
  language: string,
): Promise<string> {
  return getAiProvider().generateCodeSnippet(prompt, language);
}

export async function generateTranslation(
  text: string,
  targetLanguage: string,
): Promise<string> {
  return getAiProvider().generateTranslation(text, targetLanguage);
}

export async function analyzeDataset(data: string): Promise<string> {
  return getAiProvider().analyzeDataset(data);
}
