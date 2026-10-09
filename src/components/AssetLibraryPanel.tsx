import { useEffect, useRef } from 'react';
import type { AssetProject } from '../lib/localAssets/library';

type Props = {
  projects: AssetProject[];
  project: AssetProject | null;
  persisted: boolean;
  disabled: boolean;
  message: string;
  error: string;
  onImport: (files: File[]) => void;
  onAddMotions: (files: File[]) => void;
  onProjectChange: (id: string) => void;
  onModelChange: (path: string) => void;
  onRemove: (id: string) => void;
  onSave: () => void;
};

function sizeLabel(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export default function AssetLibraryPanel(props: Props) {
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const motionInput = useRef<HTMLInputElement>(null);
  useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', ''); }, []);
  const pick = (input: HTMLInputElement, callback: (files: File[]) => void) => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) callback(files);
  };
  return (
    <section className="asset-library" aria-label="本地模型与动作">
      <div className="asset-library-heading">
        <h1>3Dto2Dshape</h1>
        <a href="https://github.com/ANGJustinl/3Dto2Dshape" target="_blank" rel="noreferrer">Fork ↗</a>
      </div>
      <h2>本地模型与动作</h2>
      <p>选择模型文件夹，保留模型与贴图的目录结构。文件在本机浏览器处理。</p>
      <input ref={folderInput} type="file" multiple hidden disabled={props.disabled}
        onChange={(event) => pick(event.currentTarget, props.onImport)} aria-label="选择模型文件夹" />
      <input ref={fileInput} type="file" multiple hidden disabled={props.disabled}
        accept=".pmx,.pmd,.vmd,.png,.jpg,.jpeg,.bmp,.tga,.sph,.spa,.gif,.webp"
        onChange={(event) => pick(event.currentTarget, props.onImport)} aria-label="选择模型及贴图文件" />
      <input ref={motionInput} type="file" multiple hidden disabled={props.disabled} accept=".vmd"
        onChange={(event) => pick(event.currentTarget, props.onAddMotions)} aria-label="选择动作文件" />
      <div className="asset-library-actions">
        <button type="button" disabled={props.disabled} onClick={() => folderInput.current?.click()}>导入模型文件夹</button>
        <button type="button" disabled={props.disabled} onClick={() => fileInput.current?.click()}>选择模型及贴图</button>
      </div>
      <p className="asset-library-hint">支持 PMX / PMD；压缩包请先解压。动作使用 VMD，可单独添加。</p>
      {props.projects.length > 0 && (
        <label className="projection-select">
          <span>浏览器素材库</span>
          <select value={props.project?.id ?? ''} disabled={props.disabled}
            onChange={(event) => props.onProjectChange(event.currentTarget.value)}>
            {!props.project && <option value="" disabled>选择已保存模型</option>}
            {props.project && !props.projects.some((project) => project.id === props.project!.id) && (
              <option value={props.project.id}>{props.project.name}（本次使用）</option>
            )}
            {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {sizeLabel(project.totalBytes)}</option>)}
          </select>
        </label>
      )}
      {props.project && (
        <>
          <label className="projection-select">
            <span>模型路径</span>
            <select value={props.project.selectedModelPath} disabled={props.disabled}
              onChange={(event) => props.onModelChange(event.currentTarget.value)}>
              {props.project.modelPaths.map((path) => <option key={path} value={path}>{path}</option>)}
            </select>
          </label>
          <p className="asset-library-hint">{props.project.fileCount} 个文件 · {sizeLabel(props.project.totalBytes)} · {props.persisted ? '已保存在此浏览器' : '尚未保存'}</p>
          <div className="asset-library-actions">
            <button type="button" disabled={props.disabled} onClick={() => motionInput.current?.click()}>添加 VMD 动作</button>
            <button type="button" disabled={props.disabled} onClick={() => props.onRemove(props.project!.id)}>移除浏览器副本</button>
            {!props.persisted && <button type="button" disabled={props.disabled} onClick={props.onSave}>保存到浏览器</button>}
          </div>
          <p className="asset-library-hint">刷新后继续使用上次模型与动作。清除网站数据会移除副本，请保留原始文件。</p>
        </>
      )}
      {props.message && <p className="asset-library-message" role="status">{props.message}</p>}
      {props.error && <p className="asset-library-error" role="alert">{props.error}</p>}
    </section>
  );
}
