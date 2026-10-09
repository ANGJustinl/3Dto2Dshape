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
    <details className="export-panel asset-library" open>
      <summary>Local Assets</summary>
      <div className="export-panel-body">
        <div className="export-hint">Import a model folder with its original texture paths. Files are processed locally in your browser.</div>
        <input ref={folderInput} type="file" multiple hidden disabled={props.disabled}
          onChange={(event) => pick(event.currentTarget, props.onImport)} aria-label="Import Model Folder" />
        <input ref={fileInput} type="file" multiple hidden disabled={props.disabled}
          accept=".pmx,.pmd,.vmd,.png,.jpg,.jpeg,.bmp,.tga,.sph,.spa,.gif,.webp"
          onChange={(event) => pick(event.currentTarget, props.onImport)} aria-label="Select Model & Textures" />
        <input ref={motionInput} type="file" multiple hidden disabled={props.disabled} accept=".vmd"
          onChange={(event) => pick(event.currentTarget, props.onAddMotions)} aria-label="Add VMD Motion" />
        <div className="export-grid-2">
          <button type="button" className="part-chip" disabled={props.disabled} onClick={() => folderInput.current?.click()}>Import Model Folder</button>
          <button type="button" className="part-chip" disabled={props.disabled} onClick={() => fileInput.current?.click()}>Select Model &amp; Textures</button>
        </div>
        <div className="export-hint">PMX / PMD models and VMD motions. Extract archives before importing.</div>
        {props.projects.length > 0 && (
          <label className="projection-select">
            <span>Browser Library</span>
            <select value={props.project?.id ?? ''} disabled={props.disabled}
              onChange={(event) => props.onProjectChange(event.currentTarget.value)}>
              {!props.project && <option value="" disabled>Select a saved model</option>}
              {props.project && !props.projects.some((project) => project.id === props.project!.id) && (
                <option value={props.project.id}>{props.project.name} (Current Session)</option>
              )}
              {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {sizeLabel(project.totalBytes)}</option>)}
            </select>
          </label>
        )}
        {props.project && (
          <>
            <label className="projection-select">
              <span>Model Path</span>
              <select value={props.project.selectedModelPath} disabled={props.disabled}
                onChange={(event) => props.onModelChange(event.currentTarget.value)}>
                {props.project.modelPaths.map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
            </label>
            <div className="export-hint">{props.project.fileCount} files · {sizeLabel(props.project.totalBytes)} · {props.persisted ? 'Saved in This Browser' : 'Not Saved'}</div>
            <div className="export-grid-2">
              <button type="button" className="part-chip" disabled={props.disabled} onClick={() => motionInput.current?.click()}>Add VMD Motion</button>
              <button type="button" className="part-chip" disabled={props.disabled} onClick={() => props.onRemove(props.project!.id)}>Remove Saved Copy</button>
              {!props.persisted && <button type="button" className="part-chip" disabled={props.disabled} onClick={props.onSave}>Save to Browser</button>}
            </div>
            <div className="export-hint">Saved models and motions are restored after reloading. Keep your source files; clearing site data removes saved copies.</div>
          </>
        )}
        {props.message && <div className="export-hint" role="status">{props.message}</div>}
        {props.error && <div className="export-error" role="alert">{props.error}</div>}
        <a className="export-hint" href="https://github.com/ANGJustinl/3Dto2Dshape" target="_blank" rel="noreferrer">3Dto2Dshape Fork ↗</a>
      </div>
    </details>
  );
}
