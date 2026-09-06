const FAVORITE_ITEM_TYPES = new Set(['node', 'group', 'image', 'video']);
const FAVORITE_LIBRARY_CATEGORIES = new Set(['text', 'image', 'video', 'group', 'other']);

function normalizeFavoriteTags(value) {
  const source = Array.isArray(value) ? value : [];
  return Array.from(new Set(
    source
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .map((item) => item.slice(0, 32))
  )).slice(0, 12);
}

function normalizeFavoritePayload(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  if (nodes.length === 0) throw new Error('favorite payload requires nodes');
  return {
    version: 1,
    rootIds: Array.isArray(payload.rootIds) ? payload.rootIds.map((item) => String(item)).filter(Boolean) : [],
    nodes,
    edges: Array.isArray(payload.edges) ? payload.edges : [],
    sourceProjectUuid: payload.sourceProjectUuid ? String(payload.sourceProjectUuid) : undefined,
    sourceProjectName: payload.sourceProjectName ? String(payload.sourceProjectName).slice(0, 180) : undefined,
  };
}

function favoriteJsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function favoriteCategoryFromPayload(payload, itemType) {
  if (itemType === 'image' || itemType === 'video' || itemType === 'group') return itemType;
  const firstNode = Array.isArray(payload?.nodes) ? payload.nodes[0] : null;
  const nodeData = firstNode && typeof firstNode.data === 'object' ? firstNode.data : {};
  const nodeType = String(nodeData.type || firstNode?.type || '');
  if (nodeType === 'text') return 'text';
  if (nodeType === 'image' || nodeType === 'director_stage') return 'image';
  if (nodeType === 'video' || nodeType === 'video_merge') return 'video';
  if (nodeType === 'group') return 'group';
  return 'other';
}

function favoriteFromRow(row, user, options = {}) {
  const isOwner = Number(row.owner_id) === Number(user.id);
  const canManage = isOwner || user.role === 'admin';
  const includePayload = options.includePayload !== false;
  const parsedPayload = includePayload ? normalizeFavoritePayload(favoriteJsonValue(row.payload, {})) : null;
  return {
    id: String(row.id),
    ownerId: Number(row.owner_id),
    ownerName: row.owner_name || '',
    sourceProjectUuid: row.source_project_uuid || '',
    sourceRootKey: row.source_root_key || '',
    itemType: row.item_type || 'node',
    title: row.title || 'Favorite node',
    description: row.description || '',
    previewUrl: row.preview_url || '',
    nodeCount: Number(row.node_count || 1),
    shared: Boolean(row.shared),
    tags: normalizeFavoriteTags(favoriteJsonValue(row.tags, [])),
    payload: parsedPayload || { version: 1, rootIds: [], nodes: [], edges: [] },
    category: FAVORITE_LIBRARY_CATEGORIES.has(String(row.library_category))
      ? String(row.library_category)
      : favoriteCategoryFromPayload(parsedPayload, row.item_type || 'node'),
    isOwner,
    canManage,
    createdAtMs: new Date(row.created_at).getTime(),
    updatedAtMs: new Date(row.updated_at || row.created_at).getTime(),
  };
}

function normalizeFavoriteSourceProject(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 64) : null;
}

function normalizeFavoriteSourceRoot(value) {
  const source = Array.isArray(value) ? value : String(value || '').split('|');
  const ids = source
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20);
  const key = ids.join('|');
  return key ? key.slice(0, 255) : null;
}

module.exports = {
  FAVORITE_ITEM_TYPES,
  favoriteFromRow,
  favoriteCategoryFromPayload,
  favoriteJsonValue,
  normalizeFavoritePayload,
  normalizeFavoriteSourceProject,
  normalizeFavoriteSourceRoot,
  normalizeFavoriteTags,
};
