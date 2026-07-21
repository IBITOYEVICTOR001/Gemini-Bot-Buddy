const HF_BASE_URL = "https://api-inference.huggingface.co/models";
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

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const response = await fetch(`${HF_BASE_URL}/${TRANSCRIBE_MODEL}`, {
    method: "POST",
    headers: getHfHeaders("application/octet-stream"),
    body: audioBuffer,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hugging Face transcription failed (${response.status}): ${body}`);
  }

  const json = await response.json();

  // Hugging Face Whisper returns an array of objects with "text"
  let text = "";
  if (Array.isArray(json) && json.length > 0 && typeof json[0].text === "string") {
    text = json[0].text;
  } else if (typeof json === "object" && json !== null) {
    text =
      (json as Record<string, unknown>).text?.toString() ||
      (json as Record<string, unknown>).transcription?.toString() ||
      "";
  }

  return text.trim();
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await fetch(`${HF_BASE_URL}/${TTS_MODEL}`, {
    method: "POST",
    headers: getHfHeaders("application/json"),
    body: JSON.stringify({ inputs: text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hugging Face TTS failed (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
