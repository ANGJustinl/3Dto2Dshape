/** Local source files are saved as Blobs; temporary object URLs never enter storage. */
export type AssetFile = { path: string; blob: Blob };

export type AssetProject = {
  id: string;
  name: string;
  modelPaths: string[];
  motionPaths: string[];
  selectedModelPath: string;
  selectedMotionPath: string;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
  updatedAt: number;
};

export type AssetWorkspace = { project: AssetProject; files: AssetFile[]; persisted: boolean };
export const INITIAL_POSE = '__initial_pose__';

export function normalizeAssetPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('文件路径超出了所选文件夹。');
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

const supportedResource = /\.(pmx|pmd|vmd|png|jpe?g|bmp|tga|sph|spa|gif|webp)$/i;

export function collectAssetFiles(files: File[]): AssetFile[] {
  const result = new Map<string, AssetFile>();
  for (const file of files) {
    const path = normalizeAssetPath(file.webkitRelativePath || file.name);
    if (supportedResource.test(path)) {
      if (result.has(path)) throw new Error(`有重复文件路径：${path}`);
      result.set(path, { path, blob: file });
    }
  }
  return [...result.values()];
}

export function createAssetWorkspace(files: File[]): AssetWorkspace {
  const assets = collectAssetFiles(files);
  const modelPaths = assets.filter((file) => /\.(pmx|pmd)$/i.test(file.path)).map((file) => file.path).sort();
  if (!modelPaths.length) throw new Error('请选择包含 .pmx 或 .pmd 模型及贴图的文件夹。压缩包请先解压。');
  const motionPaths = assets.filter((file) => /\.vmd$/i.test(file.path)).map((file) => file.path).sort();
  const now = Date.now();
  return {
    files: assets,
    persisted: false,
    project: {
      id: crypto.randomUUID(),
      name: modelPaths[0].split('/').at(-1)!.replace(/\.(pmx|pmd)$/i, ''),
      modelPaths,
      motionPaths,
      selectedModelPath: modelPaths[0],
      selectedMotionPath: INITIAL_POSE,
      fileCount: assets.length,
      totalBytes: assets.reduce((sum, file) => sum + file.blob.size, 0),
      createdAt: now,
      updatedAt: now,
    },
  };
}

export function addWorkspaceMotions(workspace: AssetWorkspace, files: File[]): AssetWorkspace {
  const motions = files.filter((file) => /\.vmd$/i.test(file.name));
  if (!motions.length) throw new Error('请选择 .vmd 动作文件。');
  const merged = new Map(workspace.files.map((file) => [file.path, file]));
  for (const file of motions) {
    const path = normalizeAssetPath(`_imported_motions/${file.name}`);
    merged.set(path, { path, blob: file });
  }
  const assets = [...merged.values()];
  return {
    files: assets,
    persisted: false,
    project: {
      ...workspace.project,
      motionPaths: assets.filter((file) => /\.vmd$/i.test(file.path)).map((file) => file.path).sort(),
      selectedMotionPath: normalizeAssetPath(`_imported_motions/${motions[0].name}`),
      fileCount: assets.length,
      totalBytes: assets.reduce((sum, file) => sum + file.blob.size, 0),
      updatedAt: Date.now(),
    },
  };
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openLibrary(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('当前浏览器无法保存本地文件。'));
        return;
      }
      const request = indexedDB.open('3dto2d-local-assets', 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('projects', { keyPath: 'id' });
        const assets = database.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        assets.createIndex('projectId', 'projectId');
        database.createObjectStore('preferences');
      };
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return; }
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('无法打开浏览器素材库。'));
      request.onblocked = () => {
        blocked = true;
        reject(new Error('请关闭其他旧版本页面后重试。'));
      };
    }).catch((error) => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('读取浏览器素材失败。'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('浏览器保存已中止。'));
    transaction.onerror = () => reject(transaction.error ?? new Error('浏览器保存失败。'));
  });
}

export async function readLibraryIndex(): Promise<{ projects: AssetProject[]; activeId?: string }> {
  const database = await openLibrary();
  const transaction = database.transaction(['projects', 'preferences'], 'readonly');
  const [projects, activeId] = await Promise.all([
    requestResult<AssetProject[]>(transaction.objectStore('projects').getAll()),
    requestResult<string | undefined>(transaction.objectStore('preferences').get('activeProject')),
  ]);
  return { projects: projects.sort((a, b) => b.updatedAt - a.updatedAt), activeId };
}

export async function loadWorkspace(id: string): Promise<AssetWorkspace> {
  const database = await openLibrary();
  const transaction = database.transaction(['projects', 'files'], 'readonly');
  const [project, records] = await Promise.all([
    requestResult<AssetProject | undefined>(transaction.objectStore('projects').get(id)),
    requestResult<Array<AssetFile & { projectId: string }>>(
      transaction.objectStore('files').index('projectId').getAll(id),
    ),
  ]);
  if (!project || !records.length) throw new Error('保存的素材已被清除，请重新导入。');
  return { project, files: records.map(({ path, blob }) => ({ path, blob })), persisted: true };
}

export async function saveWorkspace(workspace: AssetWorkspace): Promise<void> {
  const database = await openLibrary();
  const transaction = database.transaction(['projects', 'files', 'preferences'], 'readwrite');
  const completion = transactionDone(transaction);
  transaction.objectStore('projects').put(workspace.project);
  const store = transaction.objectStore('files');
  // All files in this workspace are retained; adding/replacing motions is atomic.
  for (const file of workspace.files) store.put({ projectId: workspace.project.id, ...file });
  transaction.objectStore('preferences').put(workspace.project.id, 'activeProject');
  await completion;
}

export async function saveProjectSelection(project: AssetProject): Promise<void> {
  const database = await openLibrary();
  const transaction = database.transaction(['projects', 'preferences'], 'readwrite');
  const completion = transactionDone(transaction);
  transaction.objectStore('projects').put(project);
  transaction.objectStore('preferences').put(project.id, 'activeProject');
  await completion;
}

export async function removeWorkspace(id: string): Promise<void> {
  const database = await openLibrary();
  const transaction = database.transaction(['projects', 'files', 'preferences'], 'readwrite');
  const completion = transactionDone(transaction);
  transaction.objectStore('projects').delete(id);
  const cursor = transaction.objectStore('files').index('projectId').openCursor(IDBKeyRange.only(id));
  cursor.onsuccess = () => {
    if (cursor.result) { cursor.result.delete(); cursor.result.continue(); }
  };
  const preference = transaction.objectStore('preferences').get('activeProject');
  preference.onsuccess = () => {
    if (preference.result === id) transaction.objectStore('preferences').delete('activeProject');
  };
  await completion;
}

export function storageFailureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '浏览器空间不足。本次仍可使用，刷新后需重新选择文件；可先移除不用的浏览器素材。';
  }
  return '浏览器未能保存文件。本次仍可使用，刷新后需重新选择文件。';
}
