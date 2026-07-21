// hf-tts-transcribe.ts
const HF_BASE_URL = "https://router.huggingface.co/hf-inference/models";
const TRANSCRIBE_MODEL = "openai/whisper-large-v3";
const TTS_MODEL = "facebook/mms-tts-eng";

function getHfToken(): string {
  const token = process.env["HF_TOKEN"];
  if (!token) {
    throw new Error("HF_TOKEN is not set");
  }
  return token;
}

function getHfHeaders(addContentType?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getHfToken()}`,
  };
  if (addContentType) {
    headers["Content-Type"] = addContentType;
  }
  return headers;
}

function debugLog(...args: unknown[]) {
  if (process.env.DEBUG_HF === "true") {
    // eslint-disable-next-line no-console
    console.debug("[hf-debug]", ...args);
  }
}

async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  initialDelayMs = 300
): Promise<T> {
  let attempt = 0;
  let delay = initialDelayMs;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= attempts) throw err;
      // eslint-disable-next-line no-console
      console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`);
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2;
    }
  }
}

/**
 * Send raw audio to Hugging Face Whisper and return the transcribed text.
 * Handles both object and array responses and common field names.
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  return retry(async () => {
    const response = await fetch(`${HF_BASE_URL}/${TRANSCRIBE_MODEL}`, {
      method: "POST",
      headers: getHfHeaders("application/octet-stream"),
      body: audioBuffer,
    });

    const contentType = response.headers.get("content-type") || "";
    debugLog("transcribe content-type:", contentType);

    const textFromJson = async () => {
      const json = await response.json();
      debugLog("transcribe raw json:", json);
      let text = "";

      if (Array.isArray(json)) {
        text = json
          .map((item) => {
            if (item && typeof item === "object") {
              // @ts-ignore
              return typeof item.text === "string"
                ? item.text
                : typeof item.transcription === "string"
                ? item.transcription
                : "";
            }
            return "";
          })
          .filter(Boolean)
          .join(" ")
          .trim();
      } else if (json && typeof json === "object") {
        // @ts-ignore
        text =
          typeof json.text === "string"
            ? json.text
            : typeof json.transcription === "string"
            ? json.transcription
            : "";
      } else {
        throw new Error("Unexpected Hugging Face transcription response.");
      }

      return text.trim();
    };

    if (!response.ok) {
      // Try to read body as text for error details
      const body = await response.text();
      debugLog("transcribe error body:", body);
      throw new Error(`Hugging Face transcription failed (${response.status}): ${body}`);
    }

    if (contentType.includes("application/json") || contentType.includes("text/json")) {
      return textFromJson();
    }

    // If content-type is not JSON, still attempt to parse as JSON safely
    try {
      return await textFromJson();
    } catch (err) {
      throw new Error("Unable to parse transcription response as JSON.");
    }
  });
}

/**
 * Synthesize speech using the specified TTS model and return an audio Buffer.
 * This function checks content-type and surfaces JSON error payloads.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  return retry(async () => {
    const response = await fetch(`${HF_BASE_URL}/${TTS_MODEL}`, {
      method: "POST",
      headers: getHfHeaders("application/json"),
      body: JSON.stringify({ inputs: text }),
    });

    const contentType = response.headers.get("content-type") || "";
    debugLog("tts content-type:", contentType);

    if (!response.ok) {
      const body = await response.text();
      debugLog("tts error body:", body);
      throw new Error(`Hugging Face TTS failed (${response.status}): ${body}`);
    }

    // If the endpoint returned JSON, it's likely an error or message
    if (contentType.includes("application/json") || contentType.includes("text/json")) {
      const json = await response.json();
      debugLog("tts returned json:", json);
      throw new Error(`Hugging Face TTS returned JSON instead of audio: ${JSON.stringify(json)}`);
    }

    // Accept common audio content types
    if (
      contentType.includes("audio/") ||
      contentType.includes("application/octet-stream") ||
      contentType === ""
    ) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // Fallback: try to read as arrayBuffer but warn
    debugLog("tts unexpected content-type, attempting to read as arrayBuffer");
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  });
}
