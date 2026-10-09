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
  const [message, setMessage] = useState('正在读取浏览器素材库…');
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
          setMessage('已恢复上次的模型与动作。');
        } else {
          setMessage('导入一个模型文件夹开始使用。');
        }
      } catch (cause) {
        if (!cancelled) setMessage(cause instanceof Error ? `${cause.message} 仍可导入文件供本次使用。` : '无法读取素材库，仍可导入文件供本次使用。');
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
      setMessage('模型、贴图与动作已保存在此浏览器。');
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
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重新选择文件。'); }
    finally { actionRef.current = false; setLoading(false); }
  };

  const importFiles = (selectedFiles: File[]) => {
    void runAction(async () => {
      const next = createAssetWorkspace(selectedFiles);
      setMessage('正在保存模型与贴图…');
      setWorkspace(await persist(next));
    });
  };

  const addMotions = (selectedFiles: File[]) => {
    if (!workspace) return;
    void runAction(async () => {
      const next = addWorkspaceMotions(workspace, selectedFiles);
      setMessage('正在保存动作文件…');
      setWorkspace(await persist(next));
    });
  };

  const selectProject = (id: string) => {
    if (id === workspace?.project.id) return;
    void runAction(async () => {
      const next = await loadWorkspace(id);
      try { await saveProjectSelection(next.project); setMessage('已加载保存的模型。'); }
      catch { setMessage('模型已加载，但未能保存本次选择。'); }
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
        if (generation.current === currentGeneration) setMessage('本次选择未能保存，刷新后将恢复之前的选择。');
      });
    }
  };

  const removeProject = (id: string) => {
    void runAction(async () => {
      if (projects.some((project) => project.id === id)) await removeWorkspace(id);
      setProjects((current) => current.filter((project) => project.id !== id));
      if (workspace?.project.id === id) setWorkspace(null);
      setMessage('浏览器中的副本已移除。原始文件仍在你的本地文件夹中。');
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
        <div className="viewport-pane workspace-placeholder"><h2>3D 模型</h2><p>选择本地模型与贴图，预览原始画面。</p></div>
        <div className="result-pane workspace-placeholder"><h2>2D 画面</h2><p>渲染、调整参数、烘焙 Live2D 或导出视频。</p></div>
      </div>
    );
  }

  return (
    <App key={`${session.id}/${project.selectedModelPath}`}
      initialModelUrl={session.urlFor(project.selectedModelPath)}
      initialModelName={project.selectedModelPath.split('/').at(-1)!.replace(/\.(pmx|pmd)$/i, '')}
      initialAnimationValue={project.motionPaths.includes(project.selectedMotionPath) ? project.selectedMotionPath : INITIAL_POSE}
      animationOptions={[{ label: '初始姿态', value: INITIAL_POSE }, ...project.motionPaths.map((path) => ({ label: path, value: path }))]}
      resolveAssetUrl={session.resolveUrl} resolveAnimationUrl={session.urlFor}
      onAnimationSelection={(path) => selectSource({ selectedMotionPath: path })}
      onOperationStateChange={handleOperationState} assetPanel={panel} sourceBusy={loading} />
  );
}
