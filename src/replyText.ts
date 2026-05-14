export function splitWeixinReply(text: string, maxChars = 3200): string[] {
  const input = (text ?? "").trim();
  if (!input) {
    return ["空回复。"];
  }
  if (input.length <= maxChars) {
    return [input];
  }

  const chunks: string[] = [];
  let remaining = input;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) {
      cut = remaining.lastIndexOf(" ", maxChars);
    }
    if (cut < maxChars * 0.5) {
      cut = maxChars;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
