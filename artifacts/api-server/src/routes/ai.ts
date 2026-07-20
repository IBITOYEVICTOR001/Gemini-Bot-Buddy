import { Router } from "express";
import {
  analyzeDataset,
  decideSearch,
  generateCodeSnippet,
  generateConversationReply,
  generateCreativeOutput,
  generateGame,
  generateTranslation,
  type ChatMessage,
} from "../services/gemini";
import { runTavilySearch, type SearchResult } from "../services/tavily";
import { synthesizeSpeech, transcribeAudio } from "../services/hf";
import {
  createVideoJob,
  fetchVideoStatus,
  pollVideoCompletion,
} from "../services/json2video";

const router = Router();

router.post("/gemini/chat", async (req, res) => {
  const body = req.body as {
    text?: string;
    history?: ChatMessage[];
    searchResults?: SearchResult[];
  };
  if (!body.text) {
    return res.status(400).json({ error: "Missing text field in request body." });
  }

  try {
    const reply = await generateConversationReply(
      body.text,
      body.history ?? [],
      body.searchResults ?? [],
    );
    return res.json({ reply });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/gemini/translate", async (req, res) => {
  const { text, targetLanguage } = req.body as {
    text?: string;
    targetLanguage?: string;
  };
  if (!text) {
    return res.status(400).json({ error: "Missing text field in request body." });
  }

  try {
    const translation = await generateTranslation(text, targetLanguage ?? "English");
    return res.json({ translation });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/gemini/creative", async (req, res) => {
  const { type, topic } = req.body as {
    type?: "story" | "poem" | "dialogue" | "projectIdeas";
    topic?: string;
  };
  if (!type || !topic) {
    return res.status(400).json({ error: "Missing type or topic in request body." });
  }

  try {
    const output = await generateCreativeOutput(type, topic);
    return res.json({ output });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/gemini/game", async (req, res) => {
  const { gameType, subject } = req.body as {
    gameType?: "hangman" | "20questions" | "wordjumble";
    subject?: string;
  };
  if (!gameType) {
    return res.status(400).json({ error: "Missing gameType in request body." });
  }

  try {
    const game = await generateGame(gameType, subject ?? "fun topic");
    return res.json({ game });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/gemini/code", async (req, res) => {
  const { request, language } = req.body as {
    request?: string;
    language?: string;
  };
  if (!request) {
    return res.status(400).json({ error: "Missing request field in request body." });
  }

  try {
    const code = await generateCodeSnippet(request, language ?? "JavaScript");
    return res.json({ code });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/gemini/analyze", async (req, res) => {
  const { data, question } = req.body as {
    data?: unknown;
    question?: string;
  };
  if (!data || !question) {
    return res.status(400).json({ error: "Missing data or question in request body." });
  }

  try {
    const analysis = await analyzeDataset(data, question);
    return res.json({ analysis });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/research", async (req, res) => {
  const { query } = req.body as { query?: string };
  if (!query) {
    return res.status(400).json({ error: "Missing query field in request body." });
  }

  try {
    const results = await runTavilySearch(query);
    const summary = await generateConversationReply(query, [], results);
    return res.json({ results, summary });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/audio/transcribe", async (req, res) => {
  const { audioBase64, audioUrl } = req.body as {
    audioBase64?: string;
    audioUrl?: string;
  };
  if (!audioBase64 && !audioUrl) {
    return res.status(400).json({ error: "Provide audioBase64 or audioUrl in request body." });
  }

  try {
    let buffer: Buffer;
    if (audioBase64) {
      buffer = Buffer.from(audioBase64, "base64");
    } else {
      const response = await fetch(audioUrl!);
      if (!response.ok) {
        throw new Error(`Failed to download audio: ${response.status}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }
    const transcript = await transcribeAudio(buffer);
    return res.json({ transcript });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/audio/synthesize", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text) {
    return res.status(400).json({ error: "Missing text field in request body." });
  }

  try {
    const audioBuffer = await synthesizeSpeech(text);
    return res.json({ audioBase64: audioBuffer.toString("base64") });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.post("/video", async (req, res) => {
  const { prompt, orientation, durationSeconds } = req.body as {
    prompt?: string;
    orientation?: "horizontal" | "vertical";
    durationSeconds?: number;
  };
  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt field in request body." });
  }

  try {
    const job = await createVideoJob(
      prompt,
      orientation ?? "horizontal",
      durationSeconds ?? 20,
    );
    const completion = await pollVideoCompletion(job.jobId, {
      intervalMs: 5000,
      maxAttempts: 20,
    });
    return res.json({ jobId: job.jobId, downloadUrl: completion.downloadUrl });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

router.get("/video/status/:jobId", async (req, res) => {
  try {
    const status = await fetchVideoStatus(req.params.jobId);
    return res.json(status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

export default router;
