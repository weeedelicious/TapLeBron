const VIDEO_EXTENSION_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

function videoExtensionFromUrl(url: string) {
  const clean = String(url || "").split("#")[0].split("?")[0];
  const match = clean.match(/\.(mp4|mov|m4v|webm|mkv|avi)$/i);
  return match?.[1]?.toLowerCase() || "";
}

/** 下载属性会覆盖 URL 文件名；节点展示名没后缀时要把真实视频后缀补回来。 */
export function videoDownloadFileName(name: string | undefined, url: string) {
  const urlName = String(url || "").split("#")[0].split("?")[0].split("/").pop() || "";
  const requestedName = String(name || urlName || "video").trim() || "video";
  const extension = videoExtensionFromUrl(url);
  if (!extension) return requestedName;
  if (requestedName.toLowerCase().endsWith(`.${extension}`)) return requestedName;
  return `${requestedName.replace(VIDEO_EXTENSION_RE, "")}.${extension}`;
}
