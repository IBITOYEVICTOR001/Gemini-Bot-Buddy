import { tavily, type TavilyClient } from "@tavily/core";

export type SearchResult = {
  title: string;
  url: string;
  content: string;
};

let tavilyClient: TavilyClient | null = null;

function getTavilyClient(): TavilyClient {
  if (!tavilyClient) {
    const apiKey = process.env["TAVILY_API_KEY"];
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY is not set");
    }
    tavilyClient = tavily({ apiKey });
  }
  return tavilyClient;
}

export async function runTavilySearch(query: string): Promise<SearchResult[]> {
  try {
    const client = getTavilyClient();
    const response = await client.search(query, {
      searchDepth: "basic",
      maxResults: 6,
      includeAnswer: false,
    });

    return (response.results ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      content: result.content ?? "",
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Tavily] Search failed: ${message}`);
    return [];
  }
}
