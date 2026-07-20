export type Json2VideoJobResponse = {
  jobId: string;
  statusUrl: string;
  raw: unknown;
};

const JSON2VIDEO_API_URL = "https://api.json2video.com/v2/movies";

function getJson2VideoApiKey(): string {
  const apiKey = process.env["JSON2VIDEO_API_KEY"];
  if (!apiKey) {
    throw new Error("JSON2VIDEO_API_KEY is not set");
  }
  return apiKey;
}

function getJson2VideoHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getJson2VideoApiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export async function createVideoJob(
  prompt: string,
  orientation: "horizontal" | "vertical" = "horizontal",
  durationSeconds = 20,
): Promise<Json2VideoJobResponse> {
  if (durationSeconds <= 0 || durationSeconds > 60) {
    throw new Error("Video duration must be between 1 and 60 seconds.");
  }

  const aspectRatio = orientation === "vertical" ? "9:16" : "16:9";
  const payload = {
    input: {
      prompt,
      duration: durationSeconds,
      aspect_ratio: aspectRatio,
      format: "mp4",
      voice: "neutral",
    },
  };

  const response = await fetch(JSON2VIDEO_API_URL, {
    method: "POST",
    headers: getJson2VideoHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`JSON2Video job creation failed (${response.status}): ${body}`);
  }

  const body = await response.json();
  const jobId =
    String((body as Record<string, unknown>).id ?? (body as Record<string, unknown>).jobId ?? "");
  const statusUrl =
    String(
      (body as Record<string, unknown>).statusUrl ??
        (body as Record<string, unknown>).url ??
        `${JSON2VIDEO_API_URL}/${jobId}`,
    );

  if (!jobId) {
    throw new Error(`Unable to parse JSON2Video job ID from response: ${JSON.stringify(body)}`);
  }

  return { jobId, statusUrl, raw: body };
}

export async function fetchVideoStatus(jobId: string): Promise<{
  status: string;
  progress: number;
  downloadUrl?: string;
  raw: unknown;
}> {
  const statusUrl = `${JSON2VIDEO_API_URL}/${encodeURIComponent(jobId)}`;
  const response = await fetch(statusUrl, {
    method: "GET",
    headers: getJson2VideoHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`JSON2Video status check failed (${response.status}): ${body}`);
  }

  const body = await response.json();
  const result = body as Record<string, unknown>;
  const status = String(result.status ?? result.state ?? "unknown");
  const progress = Number(result.progress ?? (result.status === "completed" ? 100 : 0));
  const downloadUrl =
    String(
      result.download_url ??
        result.downloadUrl ??
        (result.result as Record<string, unknown>)?.download_url ??
        (result.result as Record<string, unknown>)?.downloadUrl ??
        "",
    );

  return {
    status,
    progress: Number.isFinite(progress) ? progress : 0,
    downloadUrl: downloadUrl || undefined,
    raw: body,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollVideoCompletion(
  jobId: string,
  options?: { intervalMs?: number; maxAttempts?: number },
): Promise<{ downloadUrl: string; status: string; raw: unknown }> {
  const intervalMs = options?.intervalMs ?? 5000;
  const maxAttempts = options?.maxAttempts ?? 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await fetchVideoStatus(jobId);
    if (status.progress >= 100 || status.status.toLowerCase() === "completed") {
      if (!status.downloadUrl) {
        throw new Error(
          `Video finished processing but the download link is missing for job ${jobId}`,
        );
      }
      return { downloadUrl: status.downloadUrl, status: status.status, raw: status.raw };
    }

    if (status.status.toLowerCase() === "failed") {
      throw new Error(`JSON2Video job ${jobId} failed.`);
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `JSON2Video job ${jobId} did not complete within the expected polling window.`,
  );
}
