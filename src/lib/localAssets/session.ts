import { normalizeAssetPath, type AssetFile } from './library';

/** MMDLoader keeps this virtual base for relative textures; LoadingManager resolves to Blobs. */
export function createAssetSession(projectId: string, files: AssetFile[]) {
  const prefix = `local-assets://${projectId}/`;
  const assets = new Map(files.map((file) => [file.path, file.blob]));
  const byLowerCase = new Map<string, string[]>();
  const byBasename = new Map<string, string[]>();
  const objectUrls = new Map<string, string>();
  const flattenedSelection = files.every((file) => !file.path.includes('/'));
  const directPaths = new Map<string, string>();
  const modelBases = [...new Set(files.filter((file) => /\.(pmx|pmd)$/i.test(file.path))
    .map((file) => file.path.slice(0, file.path.lastIndexOf('/') + 1)))].map((path) => ({
      path, encoded: path.split('/').map(encodeURIComponent).join('/'),
    })).sort((a, b) => b.encoded.length - a.encoded.length);
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    map.set(key, [...(map.get(key) ?? []), value]);
  };
  for (const path of assets.keys()) {
    add(byLowerCase, path.toLowerCase(), path);
    add(byBasename, path.split('/').at(-1)!.toLowerCase(), path);
  }
  let disposed = false;
  return {
    id: crypto.randomUUID(),
    projectId,
    files,
    urlFor(path: string) {
      const url = prefix + path.split('/').map(encodeURIComponent).join('/');
      directPaths.set(url, path);
      return url;
    },
    resolveUrl(url: string): string {
      if (/^(data:|blob:)/i.test(url)) return url;
      if (!url.startsWith(prefix)) throw new Error(`Unable to read local asset: ${url}`);
      if (disposed) throw new Error('Local assets have been closed. Please select the model again.');
      const rawPath = url.slice(prefix.length);
      const candidates = [rawPath];
      try { candidates.unshift(decodeURIComponent(rawPath)); } catch { /* Literal percent in a filename. */ }
      // MMD appends an authored (unencoded) texture path to the encoded model
      // directory. Decode that directory only, keeping literal %, # and spaces.
      const modelBase = modelBases.find((base) => rawPath.startsWith(base.encoded));
      if (modelBase) candidates.unshift(modelBase.path + rawPath.slice(modelBase.encoded.length));
      const directPath = directPaths.get(url);
      if (directPath) candidates.unshift(directPath);
      let match: string | undefined;
      for (const candidate of candidates) {
        let path: string;
        try { path = normalizeAssetPath(candidate); } catch { continue; }
        if (assets.has(path)) { match = path; break; }
        const lowerMatches = byLowerCase.get(path.toLowerCase());
        if (lowerMatches?.length === 1) { match = lowerMatches[0]; break; }
      }
      // Multi-file pickers flatten paths. A unique filename can still be resolved safely.
      if (!match && flattenedSelection) {
        for (const candidate of candidates) {
          const name = candidate.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase();
          const matches = byBasename.get(name);
          if (matches?.length === 1) { match = matches[0]; break; }
        }
      }
      if (!match) throw new Error(`Missing texture or file: ${candidates[0]}. Please select the complete model folder again.`);
      let objectUrl = objectUrls.get(match);
      if (!objectUrl) {
        objectUrl = URL.createObjectURL(assets.get(match)!);
        objectUrls.set(match, objectUrl);
      }
      return objectUrl;
    },
    dispose() {
      disposed = true;
      for (const url of objectUrls.values()) URL.revokeObjectURL(url);
      objectUrls.clear();
    },
  };
}

export type AssetSession = ReturnType<typeof createAssetSession>;
