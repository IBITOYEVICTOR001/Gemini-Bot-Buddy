export type VideoJobResponse = {
  projectId: string;
  raw: unknown;
};

const JSON2VIDEO_BASE_URL = "https://api.json2video.com/v2";

function getJson2VideoApiKey(): string {
  const apiKey = process.env["JSON2VIDEO_API_KEY"];
  if (!apiKey) {
    throw new Error("JSON2VIDEO_API_KEY is not set");
  }
  return apiKey;
}

function getJson2VideoHeaders(): Record<string, string> {
  return {
    "x-api-key": getJson2VideoApiKey(),
    "Content-Type": "application/json",
  };
}

export async function createVideoJob(
  prompt: string,
  imageUrl: string,
  orientation: "horizontal" | "vertical" = "horizontal",
): Promise<VideoJobResponse> {
  const movie: Record<string, unknown> = {
    quality: "high",
    scenes: [
      {
       elements: [
{ type: "image", src: imageUrl, resize: "cover" },
  { type: "voice", text: prompt, model: "azure", voice: "en-US-JennyNeural" },
  { type: "subtitles" },
],
        ],
      },
    ],
  };

  if (orientation === "vertical") {
    movie.width = 1080;
    movie.height = 1920;
  } else {
    movie.resolution = "full-hd";
  }

  const response = await fetch(`${JSON2VIDEO_BASE_URL}/movies`, {
    method: "POST",
    headers: getJson2VideoHeaders(),
    body: JSON.stringify(movie),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`JSON2Video job creation failed (${response.status}): ${body}`);
  }

  const body = (await response.json()) as { success: boolean; project?: string };
  if (!body.success || !body.project) {
    throw new Error(`Unable to parse JSON2Video project ID from response: ${JSON.stringify(body)}`);
  }

  return { projectId: body.project, raw: body };
}

export async function fetchVideoStatus(projectId: string): Promise<{
  status: string;
  downloadUrl?: string;
  raw: unknown;
}> {
  const response = await fetch(
    `${JSON2VIDEO_BASE_URL}/movies/?project=${encodeURIComponent(projectId)}`,
    { method: "GET", headers: getJson2VideoHeaders() },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`JSON2Video status check failed (${response.status}): ${body}`);
  }

  const body = await response.json();
  const result = body as { movie?: { status?: string; url?: string | null } };
  const status = result.movie?.status ?? "unknown";
  const downloadUrl = result.movie?.url ?? undefined;

  return { status, downloadUrl: downloadUrl || undefined, raw: body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollVideoCompletion(
  projectId: string,
  options?: { intervalMs?: number; maxAttempts?: number },
): Promise<{ downloadUrl: string; status: string; raw: unknown }> {
  const intervalMs = options?.intervalMs ?? 5000;
  const maxAttempts = options?.maxAttempts ?? 30;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await fetchVideoStatus(projectId);
    const normalizedStatus = status.status.toLowerCase();

    if (normalizedStatus === "done") {
      if (!status.downloadUrl) {
        throw new Error(`Video finished but no download link was returned for project ${projectId}`);
      }
      return { downloadUrl: status.downloadUrl, status: status.status, raw: status.raw };
    }

    if (normalizedStatus === "error" || normalizedStatus === "failed") {
      throw new Error(`JSON2Video project ${projectId} failed.`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`JSON2Video project ${projectId} did not complete within the expected polling window.`);
}
