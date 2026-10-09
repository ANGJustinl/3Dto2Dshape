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
      if (!parts.length) throw new Error('File path is outside the selected folder.');
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
      if (result.has(path)) throw new Error(`Duplicate file path: ${path}`);
      result.set(path, { path, blob: file });
    }
  }
  return [...result.values()];
}

export function createAssetWorkspace(files: File[]): AssetWorkspace {
  const assets = collectAssetFiles(files);
  const modelPaths = assets.filter((file) => /\.(pmx|pmd)$/i.test(file.path)).map((file) => file.path).sort();
  if (!modelPaths.length) throw new Error('Select a folder containing a .pmx or .pmd model and its textures. Extract archives first.');
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
  if (!motions.length) throw new Error('Please select .vmd motion files.');
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
        reject(new Error('This browser cannot save local files.'));
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
      request.onerror = () => reject(request.error ?? new Error('Unable to open the browser library.'));
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Close other pages running an older version and try again.'));
      };
    }).catch((error) => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to read saved assets.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser save was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser save failed.'));
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
  if (!project || !records.length) throw new Error('Saved assets have been cleared. Please import them again.');
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
    return 'Browser storage is full. Files are available for this session only; import them again after reloading or remove unused saved assets and retry.';
  }
  return 'Files could not be saved in this browser. They are available for this session only; import them again after reloading.';
}
