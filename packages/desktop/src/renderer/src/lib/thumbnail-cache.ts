const THUMBNAIL_CACHE_LIMIT = 80;
export const thumbnailCache = new Map<string, string>();

export function cacheThumbnail(assetPath: string, url: string): void {
  const existing = thumbnailCache.get(assetPath);
  if (existing) URL.revokeObjectURL(existing);
  thumbnailCache.set(assetPath, url);
  while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
    const oldest = thumbnailCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const oldestUrl = thumbnailCache.get(oldest);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
    thumbnailCache.delete(oldest);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const url of thumbnailCache.values()) URL.revokeObjectURL(url);
    thumbnailCache.clear();
  });
}
