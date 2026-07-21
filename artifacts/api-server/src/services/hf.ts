// hf-tts-transcribe.ts
const HF_BASE_URL = "https://router.huggingface.co/hf-inference/models";
const TRANSCRIBE_MODEL = "openai/whisper-large-v3";

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
      const body = await response.text();
      debugLog("transcribe error body:", body);
      throw new Error(`Hugging Face transcription failed (${response.status}): ${body}`);
    }

    if (contentType.includes("application/json") || contentType.includes("text/json")) {
      return textFromJson();
    }

    try {
      return await textFromJson();
    } catch (err) {
      throw new Error("Unable to parse transcription response as JSON.");
    }
  });
}

/**
 * Synthesize speech using StreamElements' free TTS endpoint and return an audio Buffer.
 * No API key required.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const voice = "Brian"; // other options: Amy, Emma, Justin, Russell, Joey, etc.
  const url = `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`StreamElements TTS failed (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
