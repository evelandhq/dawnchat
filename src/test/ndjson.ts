export type NdjsonLine = {
  type: "delta" | "message" | "done" | "error";
  message?: string;
  error?: string;
  chat?: Record<string, unknown>;
  messages?: Array<Record<string, unknown>>;
};

export async function readNdjsonLines(response: Response): Promise<NdjsonLine[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as NdjsonLine);
}
