const THUMBNAIL_CACHE_LIMIT = 80;
export const thumbnailCache = new Map<string, string>();

export function cacheThumbnail(assetPath: string, url: string): void {
  const existing = thumbnailCache.get(assetPath);
  revokeThumbnailUrl(existing);
  thumbnailCache.set(assetPath, url);
  while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
    const oldest = thumbnailCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const oldestUrl = thumbnailCache.get(oldest);
    revokeThumbnailUrl(oldestUrl);
    thumbnailCache.delete(oldest);
  }
}

export async function resolveAssetUrl(assetPath: string): Promise<string> {
  if (typeof window.beside.assetUrl === 'function') {
    return await window.beside.assetUrl(assetPath);
  }

  // Compatibility fallback for older preload bundles.
  const bytes = await window.beside.readAsset(assetPath);
  const type = assetPath.endsWith('.png')
    ? 'image/png'
    : assetPath.match(/\.jpe?g$/)
      ? 'image/jpeg'
      : 'image/webp';
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
}

function revokeThumbnailUrl(url: string | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const url of thumbnailCache.values()) revokeThumbnailUrl(url);
    thumbnailCache.clear();
  });
}
