import { Router } from "express";
import { decideSearch, generateConversationReply } from "../services/aiProvider";
import { logger } from "../lib/logger";
import { runTavilySearch } from "../services/tavily";

const router = Router();

type ApiError = {
  status: number;
  message: string;
};

function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as ApiError).status === "number" &&
    "message" in error &&
    typeof (error as ApiError).message === "string"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw { status: 400, message: `Missing or invalid ${field} field in request body.` } satisfies ApiError;
  }
  return value.trim();
}

async function generateWebChatReply(message: string): Promise<string> {
  const history = [{ role: "user" as const, content: message }];
  let searchResults: { title: string; url: string; content: string }[] = [];

  try {
    const decision = await decideSearch(message, history);
    if (decision.needs_search) {
      searchResults = await runTavilySearch(decision.search_query);
    }
  } catch (error: unknown) {
    logger.warn({ err: getErrorMessage(error) }, "API chat search decision or Tavily lookup failed");
  }

  return generateConversationReply(message, history, searchResults);
}

router.post("/", async (req, res) => {
  try {
    const message = requireString(req.body?.message, "message");
    const reply = await generateWebChatReply(message);
    return res.json({ reply });
  } catch (error: unknown) {
    const status = isApiError(error) ? error.status : 500;
    logger.error({ err: getErrorMessage(error) }, "API chat request failed");
    return res.status(status).json({ error: isApiError(error) ? error.message : "Unable to process chat request." });
  }
});

export default router;
