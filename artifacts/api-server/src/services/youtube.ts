const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

function getYoutubeApiKey(): string {
  const apiKey = process.env["YOUTUBE_API_KEY"];
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY is not set");
  }
  return apiKey;
}

export type YoutubeSearchResult = {
  title: string;
  channelTitle: string;
  videoId: string;
  url: string;
};

export async function searchYoutubeVideos(query: string, maxResults = 5): Promise<YoutubeSearchResult[]> {
  const apiKey = getYoutubeApiKey();
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    part: "snippet",
    type: "video",
    maxResults: String(maxResults),
  });

  const response = await fetch(`${YOUTUBE_API_BASE}/search?${params.toString()}`);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube search failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }>;
  };

  return (data.items ?? [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      title: item.snippet?.title ?? "Untitled",
      channelTitle: item.snippet?.channelTitle ?? "Unknown channel",
      videoId: item.id!.videoId as string,
      url: `https://www.youtube.com/watch?v=${item.id!.videoId}`,
    }));
}
