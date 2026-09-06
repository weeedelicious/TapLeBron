/**
 * 资产库的分类口径：类型 / 标签 / 项目。
 *
 * 标签和项目都存在收藏记录原有的 `tags` 数组里，用前缀区分，所以不需要改表也不需要
 * 加接口 —— /favorites/:id 和 /shared-assets/:id 的 PATCH 本来就收 tags。
 * 前缀是必须的：`tags` 里已经躺着一个业务值 'shared'（共享时写进去的），
 * 裸字符串会跟它以及以后可能加的其它标记撞在一起。
 *
 * 要加标签或项目选项，只改这个文件。
 */

export const ASSET_LABEL_TAG_PREFIX = "label:";
export const ASSET_PROJECT_TAG_PREFIX = "project:";

/** 筛选下拉里的"全部"用空串表示，不参与过滤 */
export const ASSET_FILTER_ALL = "";

export type AssetTypeFilter =
  | "all"
  | "text"
  | "image"
  | "video"
  | "group"
  | "other";

export const ASSET_TYPE_OPTIONS: Array<{ value: AssetTypeFilter; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "group", label: "组" },
  { value: "other", label: "其他" },
];

export const ASSET_LABEL_OPTIONS = ["角色", "场景"];

export const ASSET_PROJECT_OPTIONS = ["火炬", "小镇", "香肠", "RO"];

function readPrefixed(tags: readonly string[] | undefined, prefix: string) {
  for (const tag of tags ?? []) {
    const text = String(tag ?? "");
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return "";
}

function withPrefixed(
  tags: readonly string[] | undefined,
  prefix: string,
  value: string,
) {
  const rest = (tags ?? [])
    .map((tag) => String(tag ?? ""))
    .filter((tag) => tag && !tag.startsWith(prefix));
  const next = value.trim();
  return next ? [...rest, `${prefix}${next}`] : rest;
}

export function readAssetLabel(tags: readonly string[] | undefined) {
  return readPrefixed(tags, ASSET_LABEL_TAG_PREFIX);
}

export function readAssetProject(tags: readonly string[] | undefined) {
  return readPrefixed(tags, ASSET_PROJECT_TAG_PREFIX);
}

export function withAssetLabel(
  tags: readonly string[] | undefined,
  label: string,
) {
  return withPrefixed(tags, ASSET_LABEL_TAG_PREFIX, label);
}

export function withAssetProject(
  tags: readonly string[] | undefined,
  project: string,
) {
  return withPrefixed(tags, ASSET_PROJECT_TAG_PREFIX, project);
}

/** 卡片上展示的自由标签：把 label:/project: 这些内部标记和 'shared' 藏掉 */
export function visibleAssetTags(tags: readonly string[] | undefined) {
  return (tags ?? [])
    .map((tag) => String(tag ?? ""))
    .filter(
      (tag) =>
        tag &&
        tag !== "shared" &&
        !tag.startsWith(ASSET_LABEL_TAG_PREFIX) &&
        !tag.startsWith(ASSET_PROJECT_TAG_PREFIX),
    );
}
