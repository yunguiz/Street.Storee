import fs from 'fs';
import path from 'path';
// Se no server-bling.ts a função se chama callBlingApi ou outro nome, importa assim:
import { loadBlingTokens, fetchFromBling } from './server-bling';
import { Product } from './src/types';

const IMAGES_STORE_FILE = path.resolve(process.cwd(), '.bling_product_images.json');
const IMAGE_STORE_VERSION = 3;

export interface BlingImageStore {
  version?: number;
  updatedAt: string;
  bySku: Record<string, string[]>;
  byName: Record<string, string[]>;
  byId: Record<string, string[]>;
}

let cachedImageStore: BlingImageStore | null = null;
let lastSyncCompletedAt = 0;

export function getLastBlingImageSyncTime(): number {
  return lastSyncCompletedAt;
}

function isManualLocalUpload(url: string): boolean {
  const u = (url || '').trim();
  return u.startsWith('/assets/uploads/') || u.startsWith('/assets/aistudio/');
}

export function clearImageCache(preserveManualUploads: boolean = true): BlingImageStore {
  const prev = cachedImageStore || (() => {
    try {
      if (fs.existsSync(IMAGES_STORE_FILE)) {
        return JSON.parse(fs.readFileSync(IMAGES_STORE_FILE, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return null;
  })();

  const fresh: BlingImageStore = {
    version: IMAGE_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    bySku: {},
    byName: {},
    byId: {}
  };

  if (preserveManualUploads && prev) {
    for (const bucket of ['bySku', 'byName', 'byId'] as const) {
      const src = prev[bucket] || {};
      for (const [k, urls] of Object.entries(src)) {
        if (Array.isArray(urls)) {
          const kept = urls.filter((u) => typeof u === 'string' && isManualLocalUpload(u));
          if (kept.length > 0) fresh[bucket][k] = kept;
        }
      }
    }
  }

  lastSyncCompletedAt = 0;
  saveImageStore(fresh);
  console.log('[Bling Images] Image cache cleared cleanly.');
  return fresh;
}

export function loadImageStore(): BlingImageStore {
  if (cachedImageStore && cachedImageStore.version === IMAGE_STORE_VERSION) {
    return cachedImageStore;
  }
  try {
    if (fs.existsSync(IMAGES_STORE_FILE)) {
      const raw = fs.readFileSync(IMAGES_STORE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== IMAGE_STORE_VERSION) {
        return clearImageCache(true);
      }
      cachedImageStore = {
        version: parsed.version,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        bySku: parsed.bySku || {},
        byName: parsed.byName || {},
        byId: parsed.byId || {}
      };
      return cachedImageStore;
    }
  } catch (err) {
    console.warn('[Bling Images] Could not read image store file:', err);
  }

  cachedImageStore = {
    version: IMAGE_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    bySku: {},
    byName: {},
    byId: {}
  };
  return cachedImageStore;
}

export function saveImageStore(store: BlingImageStore): void {
  store.version = IMAGE_STORE_VERSION;
  cachedImageStore = store;
  store.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(IMAGES_STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Bling Images] Could not save image store file:', err);
  }
}

export function isLegacyExternalUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return u.includes('mitiendanube.com') || u.includes('tiendanube.com');
}

export function isPlaceholderImageUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return true;
  const u = url.trim().toLowerCase();
  if (!u || u.includes('unsplash.com')) return true;
  return u.startsWith('/src/assets/images/');
}

export function normalizeProductName(name: string): string {
  let n = (name || '').toLowerCase().trim();
  if (n.includes(':')) n = n.split(':')[0].trim();
  if (n.includes(' // ')) n = n.split(' // ')[0].trim();
  n = n.replace(/\s+-\s+(pp|p|m|g|gg|xg|xgg|g1|g2|g3|g4|\d{2})$/i, '').trim();
  return n.replace(/\s+/g, ' ');
}

const RESIZE_QUERY_PARAMS = new Set([
  'w', 'h', 'width', 'height', 'max-w', 'max-h', 'maxwidth', 'maxheight',
  'size', 'resize', 'quality', 'q', 'auto', 'fit', 'crop', 'dpr',
  'compress', 'compression', 'format', 'fm', 'fl', 'scale',
  'thumb', 'thumbnail', 'mini', 'miniatura', 'mode', 'blur', 'pixel', 'opt', 'optimize'
]);

export function stripResizeAndCompressionParams(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || trimmed.startsWith('data:image') || trimmed.startsWith('/')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_val, key) => {
      if (RESIZE_QUERY_PARAMS.has(key.toLowerCase())) keysToDelete.push(key);
    });
    for (const key of keysToDelete) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function isThumbnailLikeUrl(url: string): boolean {
  const u = (url || '').toLowerCase();
  if (!u) return false;
  return u.includes('miniatura') || u.includes('/thumb/') || u.includes('_thumb.') || u.includes('-thumb.');
}

const AUTH_SIGNATURE_PARAMS = new Set([
  'awsaccesskeyid', 'expires', 'signature', 'x-amz-algorithm', 'x-amz-credential',
  'x-amz-date', 'x-amz-expires', 'x-amz-signedheaders', 'x-amz-signature', 'x-amz-security-token'
]);

function getCanonicalImageKey(url: string): string {
  const clean = (url || '').trim();
  if (!clean || clean.startsWith('data:image') || clean.startsWith('/')) return clean;
  try {
    const parsed = new URL(clean);
    const toDelete: string[] = [];
    parsed.searchParams.forEach((_v, k) => {
      if (AUTH_SIGNATURE_PARAMS.has(k.toLowerCase())) toDelete.push(k);
    });
    for (const k of toDelete) parsed.searchParams.delete(k);
    return parsed.toString();
  } catch {
    return clean;
  }
}

function normalizeImageUrl(val: any, allowThumbnailFallback: boolean = false): string | null {
  if (!val) return null;
  if (typeof val === 'object') {
    const primaryCandidate = val.link || val.url || val.caminho || val.src || val.imagemURL;
    if (typeof primaryCandidate === 'string' && primaryCandidate.trim()) {
      return normalizeImageUrl(primaryCandidate, allowThumbnailFallback);
    }
    if (allowThumbnailFallback) {
      const thumbCandidate = val.linkMiniatura || val.thumbnail;
      if (typeof thumbCandidate === 'string' && thumbCandidate.trim()) {
        return normalizeImageUrl(thumbCandidate, true);
      }
    }
    return null;
  }
  if (typeof val !== 'string') return null;
  let clean = val.trim();
  if (!clean || clean === 'null' || clean === 'undefined') return null;
  if (clean.startsWith('//')) clean = `https:${clean}`;
  return stripResizeAndCompressionParams(clean);
}

function extractImagesFromSingleObject(item: any, urls: string[], allowThumbnailFallback: boolean = false) {
  if (!item || typeof item !== 'object') return;
  const push = (val: any, forceAllowThumb: boolean = allowThumbnailFallback) => {
    const normalized = normalizeImageUrl(val, forceAllowThumb);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  };
  
  if (item.midia?.imagens) {
    const imgObj = item.midia.imagens;
    if (Array.isArray(imgObj.internas)) {
      for (const i of imgObj.internas) push(i.link || i, false);
    }
    if (Array.isArray(imgObj.externas)) {
      for (const e of imgObj.externas) push(e.link || e, false);
    }
  }
  push(item.imagemURL, false);
}

export function extractImagesFromBlingItem(rawItem: any, includeVariations: boolean = true): string[] {
  if (!rawItem) return [];
  const item = rawItem?.data && typeof rawItem.data === 'object' ? rawItem.data : rawItem;
  const highResUrls: string[] = [];
  extractImagesFromSingleObject(item, highResUrls, false);

  if (includeVariations && Array.isArray(item.variacoes)) {
    for (const v of item.variacoes) extractImagesFromSingleObject(v, highResUrls, false);
  }

  const nonThumb = highResUrls.filter(u => !isThumbnailLikeUrl(u));
  if (nonThumb.length > 0) return nonThumb;
  if (highResUrls.length > 0) return highResUrls;

  const fallbacks: string[] = [];
  extractImagesFromSingleObject(item, fallbacks, true);
  return fallbacks;
}

export function applyImageRecordToStore(
  store: BlingImageStore,
  identifier: { sku?: string; name?: string; id?: string | number; parentId?: string | number },
  images: string[]
): boolean {
  if (!images || images.length === 0) return false;
  const validImages = images.map(u => normalizeImageUrl(u, true)).filter((u): u is string => Boolean(u));
  if (validImages.length === 0) return false;

  if (identifier.sku) store.bySku[String(identifier.sku).toUpperCase().trim()] = validImages;
  if (identifier.id) store.byId[String(identifier.id).trim()] = validImages;
  if (identifier.name) store.byName[normalizeProductName(identifier.name)] = validImages;
  return true;
}

export function getBlingImagesForProduct(product: Partial<Product> | any): string[] | null {
  const store = loadImageStore();
  const sku = product.integration?.sku || product.sku;
  if (sku && store.bySku[String(sku).toUpperCase().trim()]) {
    return store.bySku[String(sku).toUpperCase().trim()];
  }
  const blingId = product.integration?.blingId || product.blingId;
  if (blingId && store.byId[String(blingId).trim()]) {
    return store.byId[String(blingId).trim()];
  }
  if (product.name) {
    const n = normalizeProductName(product.name);
    if (store.byName[n]) return store.byName[n];
  }
  return null;
}

export function applyBlingImageOverrides<T extends { images?: string[]; [key: string]: any } = Product>(products: T[]): T[] {
  return products.map(product => {
    const realImages = getBlingImagesForProduct(product);
    if (realImages && realImages.length > 0) {
      return { ...product, images: realImages };
    }
    return product;
  });
}

let activeSyncPromise: Promise<any> | null = null;
let catalogFetchInProgress = false;

export async function syncImagesFromBling(options?: { maxDetailFetches?: number; clearCache?: boolean }): Promise<any> {
  if (activeSyncPromise) return activeSyncPromise;

  activeSyncPromise = (async () => {
    const store = options?.clearCache ? clearImageCache(true) : loadImageStore();
    
    // CORREÇÃO PRINCIPAL: loadBlingTokens() é async, logo precisa de await
    const tokens = await loadBlingTokens();
    if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
      console.log('[Bling Image Sync] Bling OAuth token not connected yet.');
      return { success: true, connected: false, message: 'Bling não conectado.' };
    }

    try {
      const pageData = await fetchFromBling('/produtos?pagina=1&limite=100');
      const items = pageData?.data || [];
      let updatedCount = 0;

      for (const item of items) {
        const imgs = extractImagesFromBlingItem(item);
        if (imgs.length > 0) {
          applyImageRecordToStore(store, { sku: item.codigo, id: item.id, name: item.nome }, imgs);
          updatedCount++;
        }
      }

      saveImageStore(store);
      lastSyncCompletedAt = Date.now();
      return { success: true, updatedCount, connected: true, message: 'Sincronizado com sucesso!' };
    } catch (err: any) {
      return { success: false, connected: true, error: err?.message, message: 'Erro na sync.' };
    }
  })().finally(() => {
    activeSyncPromise = null;
  });

  return activeSyncPromise;
}