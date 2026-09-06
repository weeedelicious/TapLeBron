/** `/assets/{画布id}/{文件名}`。共享空间拖下来时用来找出还指着别人画布的素材。 */

export function parseLocalAssetUrl(url: unknown): { projectUuid: string; storedName: string } | null {
  const match = String(url || "").trim().match(/^\/assets\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/);
  if (!match) return null;
  return { projectUuid: match[1], storedName: match[2] };
}

export function collectLocalAssetUrls(value: unknown, acc = new Set<string>()): string[] {
  if (typeof value === "string") {
    if (parseLocalAssetUrl(value)) acc.add(value.split(/[?#]/)[0]);
    return [...acc];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLocalAssetUrls(item, acc);
    return [...acc];
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectLocalAssetUrls(item, acc);
    }
  }
  return [...acc];
}

export function rewriteLocalAssetUrls<T>(value: T, urlMap: Record<string, string>): T {
  if (typeof value === "string") {
    const bare = value.split(/[?#]/)[0];
    const next = urlMap[bare];
    if (!next || next === bare) return value;
    return (next + value.slice(bare.length)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteLocalAssetUrls(item, urlMap)) as T;
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = rewriteLocalAssetUrls(item, urlMap);
    }
    return next as T;
  }
  return value;
}
