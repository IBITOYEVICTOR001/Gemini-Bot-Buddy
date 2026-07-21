export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env["VOICERSS_API_KEY"];
  if (!apiKey) {
    throw new Error("VOICERSS_API_KEY is not set");
  }

  const params = new URLSearchParams({
    key: apiKey,
    hl: "en-us",
    src: text,
    f: "44khz_16bit_stereo",
  });

  const response = await fetch(`https://api.voicerss.org/?${params.toString()}`);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`VoiceRSS TTS failed (${response.status}): ${body}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text") || contentType.includes("json")) {
    // VoiceRSS returns plain text errors (e.g. "ERROR: Invalid API key")
    // with a 200 status instead of a proper error code
    const body = await response.text();
    if (body.trim().toUpperCase().startsWith("ERROR")) {
      throw new Error(`VoiceRSS TTS error: ${body}`);
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
