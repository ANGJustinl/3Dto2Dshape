import { useCallback, useEffect, useRef, useState } from 'react';
import App from './App';
import AssetLibraryPanel from './components/AssetLibraryPanel';
import {
  addWorkspaceMotions, createAssetWorkspace, INITIAL_POSE, loadWorkspace, readLibraryIndex,
  removeWorkspace, saveProjectSelection, saveWorkspace, storageFailureMessage,
  type AssetProject, type AssetWorkspace,
} from './lib/localAssets/library';
import { createAssetSession, type AssetSession } from './lib/localAssets/session';

export default function WorkspaceApp() {
  const [projects, setProjects] = useState<AssetProject[]>([]);
  const [workspace, setWorkspace] = useState<AssetWorkspace | null>(null);
  const [session, setSession] = useState<AssetSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [operationBusy, setOperationBusy] = useState(false);
  const [message, setMessage] = useState('Loading browser library…');
  const [error, setError] = useState('');
  const actionRef = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const index = await readLibraryIndex();
        if (cancelled) return;
        setProjects(index.projects);
        if (index.activeId && index.projects.some((project) => project.id === index.activeId)) {
          const restored = await loadWorkspace(index.activeId);
          if (cancelled) return;
          setWorkspace(restored);
          setMessage('Restored your last model and motion.');
        } else {
          setMessage('Import a model folder to get started.');
        }
      } catch (cause) {
        if (!cancelled) setMessage(cause instanceof Error ? `${cause.message} You can still import files for this session.` : 'Unable to read the library. You can still import files for this session.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const files = workspace?.files;
  const projectId = workspace?.project.id;
  useEffect(() => {
    if (!files || !projectId) { setSession(null); return; }
    // Create in the effect so StrictMode's cleanup never revokes a reused session.
    const next = createAssetSession(projectId, files);
    setSession(next);
    return () => next.dispose();
  }, [files, projectId]);

  const updateIndex = (project: AssetProject) => {
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
  };

  const persist = async (next: AssetWorkspace) => {
    try {
      await saveWorkspace(next);
      updateIndex(next.project);
      setMessage('Model, textures and motions saved in this browser.');
      return { ...next, persisted: true };
    } catch (cause) {
      setMessage(storageFailureMessage(cause));
      return { ...next, persisted: false };
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    if (loading || operationBusy || actionRef.current) return;
    actionRef.current = true;
    generation.current += 1;
    setLoading(true);
    setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Operation failed. Please select the files again.'); }
    finally { actionRef.current = false; setLoading(false); }
  };

  const importFiles = (selectedFiles: File[]) => {
    void runAction(async () => {
      const next = createAssetWorkspace(selectedFiles);
      setMessage('Saving model and textures…');
      setWorkspace(await persist(next));
    });
  };

  const addMotions = (selectedFiles: File[]) => {
    if (!workspace) return;
    void runAction(async () => {
      const next = addWorkspaceMotions(workspace, selectedFiles);
      setMessage('Saving motion files…');
      setWorkspace(await persist(next));
    });
  };

  const selectProject = (id: string) => {
    if (id === workspace?.project.id) return;
    void runAction(async () => {
      const next = await loadWorkspace(id);
      try { await saveProjectSelection(next.project); setMessage('Loaded saved model.'); }
      catch { setMessage('Model loaded, but this selection could not be saved.'); }
      setWorkspace(next);
    });
  };

  const selectSource = (selection: Partial<Pick<AssetProject, 'selectedModelPath' | 'selectedMotionPath'>>) => {
    if (!workspace || loading || operationBusy) return;
    const project = { ...workspace.project, ...selection, updatedAt: Date.now() };
    setWorkspace({ ...workspace, project });
    const currentGeneration = generation.current;
    if (workspace.persisted) {
      void saveProjectSelection(project).then(() => {
        if (generation.current === currentGeneration) updateIndex(project);
      }).catch(() => {
        if (generation.current === currentGeneration) setMessage('Selection could not be saved. Reloading will restore the previous selection.');
      });
    }
  };

  const removeProject = (id: string) => {
    void runAction(async () => {
      if (projects.some((project) => project.id === id)) await removeWorkspace(id);
      setProjects((current) => current.filter((project) => project.id !== id));
      if (workspace?.project.id === id) setWorkspace(null);
      setMessage('Saved copy removed. Your original local files are unchanged.');
    });
  };

  const handleOperationState = useCallback((busy: boolean) => setOperationBusy(busy), []);
  const project = workspace?.project ?? null;
  const panel = (
    <AssetLibraryPanel projects={projects} project={project} persisted={workspace?.persisted ?? false}
      disabled={loading || operationBusy} message={message} error={error}
      onImport={importFiles} onAddMotions={addMotions} onProjectChange={selectProject}
      onModelChange={(path) => selectSource({ selectedModelPath: path })} onRemove={removeProject}
      onSave={() => { if (workspace) void runAction(async () => setWorkspace(await persist(workspace))); }} />
  );

  if (!project || !session || !files || session.projectId !== project.id || session.files !== files || !files.some((file) => file.path === project.selectedModelPath)) {
    return (
      <div className="app-shell workspace-empty">
        <aside className="part-panel">{panel}</aside>
        <div className="viewport-pane workspace-placeholder"><h2>3D View</h2><p>Import a local model and textures to preview the scene.</p></div>
        <div className="result-pane workspace-placeholder"><h2>2D Result</h2><p>Adjust rendering, bake Live2D or export a video.</p></div>
      </div>
    );
  }

  return (
    <App key={`${session.id}/${project.selectedModelPath}`}
      initialModelUrl={session.urlFor(project.selectedModelPath)}
      initialModelName={project.selectedModelPath.split('/').at(-1)!.replace(/\.(pmx|pmd)$/i, '')}
      initialAnimationValue={project.motionPaths.includes(project.selectedMotionPath) ? project.selectedMotionPath : INITIAL_POSE}
      animationOptions={[{ label: 'Initial Pose', value: INITIAL_POSE }, ...project.motionPaths.map((path) => ({ label: path, value: path }))]}
      resolveAssetUrl={session.resolveUrl} resolveAnimationUrl={session.urlFor}
      onAnimationSelection={(path) => selectSource({ selectedMotionPath: path })}
      onOperationStateChange={handleOperationState} assetPanel={panel} sourceBusy={loading} />
  );
}
