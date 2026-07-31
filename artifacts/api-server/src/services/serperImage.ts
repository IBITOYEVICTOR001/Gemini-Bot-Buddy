export type SerperImageResult = {
  title: string;
  imageUrl: string;
  sourceUrl: string;
};

type SerperImageApiResult = {
  title?: string;
  imageUrl?: string;
  link?: string;
  source?: string;
};

type SerperImageApiResponse = {
  images?: SerperImageApiResult[];
};

const SERPER_IMAGES_URL = "https://google.serper.dev/images";

export async function searchSerperImages(query: string, limit = 3): Promise<SerperImageResult[]> {
  const apiKey = process.env["SERPER_API_KEY"];
  if (!apiKey) {
    throw new Error("SERPER_API_KEY is not set");
  }

  const response = await fetch(SERPER_IMAGES_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Serper image search failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as SerperImageApiResponse;
  return (data.images ?? [])
    .filter((image): image is SerperImageApiResult & { imageUrl: string } => Boolean(image.imageUrl))
    .slice(0, limit)
    .map((image) => ({
      title: image.title ?? "Image result",
      imageUrl: image.imageUrl,
      sourceUrl: image.link ?? image.source ?? "",
    }));
}
