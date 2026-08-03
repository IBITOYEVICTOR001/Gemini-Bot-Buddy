import { Router, type NextFunction, type Request, type Response } from "express";
import {
  decideSearch,
  generateConversationReply,
  type ChatMessage,
} from "../services/groq";
import { runTavilySearch } from "../services/tavily";
import { searchSerperImages } from "../services/serperImage";
import {
  createDocxBuffer,
  createPdfBuffer,
  createPptxBuffer,
  createXlsxBuffer,
} from "../services/documentGen";
import { createVideoJob, fetchVideoStatus } from "../services/json2video";
import { logger } from "../lib/logger";

const router = Router();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = Number(process.env["WEB_API_RATE_LIMIT_PER_MINUTE"] ?? 30);
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const SESSION_COOKIE_NAME = "ladex_session";

type DocumentType = "pdf" | "docx" | "pptx" | "xlsx";

type GoogleUser = {
  id: string;
  email: string;
  name: string;
  picture: string;
};

function getGoogleClientId(): string {
  return process.env["GOOGLE_CLIENT_ID"]?.trim() ?? "";
}

async function upsertUser(user: GoogleUser): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    logger.warn("DATABASE_URL is not set; skipping Google user persistence");
    return;
  }

  const [{ db, usersTable }] = await Promise.all([import("@workspace/db")]);
  await db
    .insert(usersTable)
    .values({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        email: user.email,
        name: user.name,
        picture: user.picture,
        updatedAt: new Date(),
      },
    });
}

function encodeSessionCookie(user: GoogleUser): string {
  return Buffer.from(JSON.stringify({ id: user.id, email: user.email, name: user.name }), "utf8").toString("base64url");
}

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

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) {
    res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
    res.status(429).json({ error: "Too many requests. Please try again in a minute." });
    return;
  }

  bucket.count += 1;
  next();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw { status: 400, message: `Missing or invalid ${field} field in request body.` } satisfies ApiError;
  }
  return value.trim();
}

function normalizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item): item is { role: string; content: string } => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as { role?: unknown; content?: unknown };
      return (
        (candidate.role === "system" || candidate.role === "user" || candidate.role === "assistant") &&
        typeof candidate.content === "string" &&
        candidate.content.trim().length > 0
      );
    })
    .map((item) => ({ role: item.role as ChatMessage["role"], content: item.content }));
}

function formatTavilyFallback(results: { title: string; url: string; content: string }[]): string {
  const usefulResults = results.filter((result) => result.title || result.content || result.url).slice(0, 3);
  if (usefulResults.length === 0) {
    return "I'm sorry — I couldn't generate a full AI response right now. Please try again later.";
  }

  return [
    "I couldn't reach my main chat model, but I found these web results that may help:",
    ...usefulResults.map((result, index) => {
      const title = result.title || "Search result";
      const content = result.content ? `\n${result.content}` : "";
      const url = result.url ? `\n${result.url}` : "";
      return `${index + 1}. ${title}${content}${url}`;
    }),
  ].join("\n\n");
}

async function runMainChatWithFallback(message: string, history: ChatMessage[]): Promise<string> {
  let searchResults: { title: string; url: string; content: string }[] = [];

  try {
    const decision = await decideSearch(message, history);
    if (decision.needs_search) {
      searchResults = await runTavilySearch(decision.search_query);
    }
  } catch (error: unknown) {
    logger.warn({ err: getErrorMessage(error) }, "Web chat search decision or lookup failed");
  }

  try {
    return await generateConversationReply(message, [...history, { role: "user", content: message }], searchResults);
  } catch (error: unknown) {
    logger.error({ err: getErrorMessage(error) }, "Web chat primary model failed; trying Tavily fallback");
    try {
      const fallbackResults = searchResults.length > 0 ? searchResults : await runTavilySearch(message);
      return formatTavilyFallback(fallbackResults);
    } catch (fallbackError: unknown) {
      logger.warn({ err: getErrorMessage(fallbackError) }, "Web chat Tavily fallback failed");
      return "I'm sorry — I couldn't generate a full AI response right now. Please try again later.";
    }
  }
}

function createSpreadsheetRows(prompt: string): string[][] {
  return prompt
    .split(";")
    .map((row) => row.split(",").map((cell) => cell.trim()).filter(Boolean))
    .filter((row) => row.length > 0);
}

function getDocumentBuffer(prompt: string, type: DocumentType): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  switch (type) {
    case "pdf":
      return createPdfBuffer("Generated Document", prompt).then((buffer) => ({ buffer, filename: "document.pdf", contentType: "application/pdf" }));
    case "docx":
      return createDocxBuffer("Generated Document", prompt).then((buffer) => ({
        buffer,
        filename: "document.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }));
    case "pptx": {
      const slides = prompt.split("|").map((slide) => slide.trim()).filter(Boolean);
      return createPptxBuffer("Generated Presentation", slides.length > 0 ? slides : [prompt]).then((buffer) => ({
        buffer,
        filename: "presentation.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }));
    }
    case "xlsx": {
      const rows = createSpreadsheetRows(prompt);
      return createXlsxBuffer("Generated Sheet", rows.length > 0 ? rows : [[prompt]]).then((buffer) => ({
        buffer,
        filename: "spreadsheet.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));
    }
  }
}

router.use(rateLimit);

router.get("/config", (_req, res) => {
  return res.json({ googleClientId: getGoogleClientId() });
});

router.post("/auth/google", async (req, res) => {
  try {
    const credential = requireString(req.body?.credential, "credential");
    const googleClientId = getGoogleClientId();

    if (!googleClientId) {
      return res.status(500).json({ error: "Google sign-in is not configured." });
    }

    const { OAuth2Client } = await import("google-auth-library");
    const googleOAuthClient = new OAuth2Client();
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email) {
      return res.status(401).json({ error: "Google sign-in did not return a valid user profile." });
    }

    const user: GoogleUser = {
      id: payload.sub,
      email: payload.email,
      name: payload.name ?? payload.email,
      picture: payload.picture ?? "",
    };

    await upsertUser(user);

    res.cookie(SESSION_COOKIE_NAME, encodeSessionCookie(user), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30,
      path: "/",
    });

    return res.json({ user });
  } catch (error: unknown) {
    logger.warn({ err: getErrorMessage(error) }, "Google sign-in failed");
    return res.status(401).json({ error: "Invalid Google sign-in credential." });
  }
});

router.post("/chat", async (req, res) => {
  try {
    const message = requireString(req.body?.message, "message");
    const history = normalizeHistory(req.body?.history);
    const reply = await runMainChatWithFallback(message, history);
    return res.json({ reply });
  } catch (error: unknown) {
    const status = isApiError(error) ? error.status : 500;
    return res.status(status).json({ error: isApiError(error) ? error.message : "Unable to process chat request." });
  }
});

router.post("/image", async (req, res) => {
  try {
    const query = requireString(req.body?.query, "query");
    const results = await searchSerperImages(query, 10);
    return res.json({ images: results.map((image) => ({ url: image.imageUrl, title: image.title, sourceUrl: image.sourceUrl })) });
  } catch (error: unknown) {
    const status = isApiError(error) ? error.status : 500;
    return res.status(status).json({ error: isApiError(error) ? error.message : "Unable to search images right now." });
  }
});

router.post("/docs", async (req, res) => {
  try {
    const prompt = requireString(req.body?.prompt, "prompt");
    const type = req.body?.type as DocumentType | undefined;
    if (!type || !["pdf", "docx", "pptx", "xlsx"].includes(type)) {
      return res.status(400).json({ error: "Missing or invalid type field. Use pdf, docx, pptx, or xlsx." });
    }

    const { buffer, filename, contentType } = await getDocumentBuffer(prompt, type);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    return res.send(buffer);
  } catch (error: unknown) {
    const status = isApiError(error) ? error.status : 500;
    return res.status(status).json({ error: isApiError(error) ? error.message : "Unable to generate document right now." });
  }
});

router.post("/video", async (req, res) => {
  try {
    const prompt = requireString(req.body?.prompt, "prompt");
    const orientation = req.body?.orientation === "vertical" ? "vertical" : "horizontal";
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
    const job = await createVideoJob(prompt, imageUrl, orientation);
    const status = await fetchVideoStatus(job.projectId);
    return res.status(202).json({ jobId: job.projectId, status: status.status, downloadUrl: status.downloadUrl });
  } catch (error: unknown) {
    const status = isApiError(error) ? error.status : 500;
    return res.status(status).json({ error: isApiError(error) ? error.message : "Unable to start video generation right now." });
  }
});

export default router;
