export type VideoJobResponse = {
  jobId: string;
  raw: unknown;
};

const MAGIC_HOUR_BASE_URL = "https://api.magichour.ai/v1";

function getMagicHourApiKey(): string {
  const apiKey = process.env["MAGIC_HOUR_API_KEY"];
  if (!apiKey) {
    throw new Error("MAGIC_HOUR_API_KEY is not set");
  }
  return apiKey;
}

function getMagicHourHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getMagicHourApiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export async function createVideoJob(
  prompt: string,
  orientation: "horizontal" | "vertical" = "horizontal",
  durationSeconds = 5,
): Promise<VideoJobResponse> {
  const clampedDuration = Math.min(Math.max(durationSeconds, 3), 15);

  const payload = {
    name: "Telegram Bot Video",
    end_seconds: clampedDuration,
    orientation: orientation === "vertical" ? "portrait" : "landscape",
    resolution: "720p",
    style: { prompt },
  };

  const response = await fetch(`${MAGIC_HOUR_BASE_URL}/text-to-video`, {
    method: "POST",
    headers: getMagicHourHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Magic Hour job creation failed (${response.status}): ${body}`);
  }

  const body = await response.json();
  const result = body as Record<string, unknown>;
  const jobId = String(result.id ?? "");

  if (!jobId) {
    throw new Error(`Unable to parse Magic Hour job ID from response: ${JSON.stringify(body)}`);
  }

  return { jobId, raw: body };
}

export async function fetchVideoStatus(jobId: string): Promise<{
  status: string;
  downloadUrl?: string;
  raw: unknown;
}> {
  const response = await fetch(`${MAGIC_HOUR_BASE_URL}/video-projects/${encodeURIComponent(jobId)}`, {
    method: "GET",
    headers: getMagicHourHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Magic Hour status check failed (${response.status}): ${body}`);
  }

  const body = await response.json();
  const result = body as Record<string, unknown>;
  const status = String(result.status ?? "unknown");
  const downloads = (result.downloads as Array<Record<string, unknown>>) ?? [];
  const downloadUrl = downloads.length > 0 ? String(downloads[0]?.url ?? "") : "";

  return {
    status,
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
    const normalizedStatus = status.status.toLowerCase();

    if (normalizedStatus === "complete" || normalizedStatus === "completed") {
      if (!status.downloadUrl) {
        throw new Error(`Video finished but no download link was returned for job ${jobId}`);
      }
      return { downloadUrl: status.downloadUrl, status: status.status, raw: status.raw };
    }

    if (normalizedStatus === "error" || normalizedStatus === "failed") {
      throw new Error(`Magic Hour job ${jobId} failed.`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`Magic Hour job ${jobId} did not complete within the expected polling window.`);
}
