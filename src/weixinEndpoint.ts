export function normalizeWeixinEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Weixin endpoint must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Weixin endpoint must use HTTPS without embedded credentials.");
  }
  return url.toString().replace(/\/$/, "");
}
