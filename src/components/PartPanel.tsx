import { useEffect, useMemo, useRef, useState } from 'react';
import type { MaterialDebugInfo, PartNode } from '../lib/modelParts';
import type { FocusLevel, ProjectionOverlaySettings } from '../lib/2DRenderShared/types';

type PartPanelProps = {
  parts: PartNode[];
  debugMaterials: MaterialDebugInfo[];
  selectedPartId: string | null;
  projectionSettings: ProjectionOverlaySettings;
  animationOptions: Array<{ label: string; value: string }>;
  selectedAnimation: string;
  isPlaybackPaused: boolean;
  frameStride: number;
  onAnimationChange: (value: string) => void;
  onTogglePlaybackPaused: () => void;
  onStepBackwardStrideFrames: () => void;
  onStepBackwardSingleFrame: () => void;
  onStepForwardSingleFrame: () => void;
  onStepForwardStrideFrames: () => void;
  onFrameStrideChange: (value: number) => void;
  onSelect: (partId: string | null) => void;
  onProjectionSettingsChange: (settings: ProjectionOverlaySettings) => void;
};

type VisiblePartRow = {
  path: string;
  id: string;
  label: string;
  depth: number;
  triangleCount: number;
  hasChildren: boolean;
  childCount: number;
  swatchColor?: string;
};

const FOCUS_CYCLE: FocusLevel[] = ['auto', 'focal', 'support', 'abstract'];

const ROW_HEIGHT = 40;
const ROW_GAP = 4;
const ROW_STRIDE = ROW_HEIGHT + ROW_GAP;
const OVERSCAN_ROWS = 8;

const flattenVisibleParts = (parts: PartNode[], collapsedPaths: Set<string>) => {
  const rows: VisiblePartRow[] = [];
  const stack = [...parts]
    .reverse()
    .map((part, reverseIndex, array) => ({
      part,
      path: `${array.length - 1 - reverseIndex}`,
    }));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    rows.push({
      path: current.path,
      id: current.part.id,
      label: current.part.label,
      depth: current.part.depth,
      triangleCount: current.part.triangleCount,
      hasChildren: current.part.children.length > 0,
      childCount: current.part.children.length,
      swatchColor: current.part.swatchColor,
    });

    if (collapsedPaths.has(current.path)) {
      continue;
    }

    for (let index = current.part.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        part: current.part.children[index],
        path: `${current.path}.${index}`,
      });
    }
  }

  return rows;
};

const collectParentPaths = (parts: PartNode[]) => {
  const paths = new Set<string>();
  const stack = parts.map((part, index) => ({ part, path: `${index}` }));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (current.part.children.length > 0) {
      paths.add(current.path);
      current.part.children.forEach((child, index) => {
        stack.push({
          part: child,
          path: `${current.path}.${index}`,
        });
      });
    }
  }

  return paths;
};

function PartPanel({
  parts,
  debugMaterials,
  selectedPartId,
  projectionSettings,
  animationOptions,
  selectedAnimation,
  isPlaybackPaused,
  frameStride,
  onAnimationChange,
  onTogglePlaybackPaused,
  onStepBackwardStrideFrames,
  onStepBackwardSingleFrame,
  onStepForwardSingleFrame,
  onStepForwardStrideFrames,
  onFrameStrideChange,
  onSelect,
  onProjectionSettingsChange,
}: PartPanelProps) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => collectParentPaths(parts));
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);
  const listRef = useRef<HTMLDivElement | null>(null);

  const visibleRows = useMemo(() => flattenVisibleParts(parts, collapsedPaths), [parts, collapsedPaths]);
  const totalHeight = Math.max(0, visibleRows.length * ROW_STRIDE - ROW_GAP);
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_STRIDE) - OVERSCAN_ROWS);
  const endIndex = Math.min(
    visibleRows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_STRIDE) + OVERSCAN_ROWS,
  );
  const renderedRows = visibleRows.slice(startIndex, endIndex);

  useEffect(() => {
    const element = listRef.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      setViewportHeight(element.clientHeight);
    };

    updateHeight();

    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    setCollapsedPaths(collectParentPaths(parts));
    setScrollTop(0);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [parts]);

  const handleToggleCollapse = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const cyclePartFocus = (partId: string) => {
    const current = projectionSettings.partOverrides[partId]?.focusLevel ?? 'auto';
    const next = FOCUS_CYCLE[(FOCUS_CYCLE.indexOf(current) + 1) % FOCUS_CYCLE.length];
    const nextOverrides = { ...projectionSettings.partOverrides };
    if (next === 'auto') {
      const currentOverride = nextOverrides[partId];
      if (currentOverride) {
        const { focusLevel: _focusLevel, ...restOverride } = currentOverride;
        if (Object.keys(restOverride).length === 0) {
          delete nextOverrides[partId];
        } else {
          nextOverrides[partId] = restOverride;
        }
      }
      onProjectionSettingsChange({ ...projectionSettings, partOverrides: nextOverrides });
      return;
    }
    nextOverrides[partId] = {
      ...nextOverrides[partId],
      focusLevel: next,
    };
    onProjectionSettingsChange({ ...projectionSettings, partOverrides: nextOverrides });
  };

  return (
    <aside className="part-panel">
      <div className="projection-controls">
        <label className="projection-select">
          <span>Style Mode</span>
          <select
            value={projectionSettings.styleMode}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                styleMode: event.currentTarget.value as ProjectionOverlaySettings['styleMode'],
              })
            }
          >
            <option value="animationStable">Animation Stable</option>
            <option value="stillPainterly">Still Painterly</option>
          </select>
        </label>
        <label className="projection-select">
          <select
            value={selectedAnimation}
            onChange={(event) => onAnimationChange(event.currentTarget.value)}
          >
            {animationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="projection-button-row">
          <button
            type="button"
            className={isPlaybackPaused ? 'part-chip' : 'part-chip active'}
            onClick={onTogglePlaybackPaused}
          >
            {isPlaybackPaused ? 'Play' : 'Pause'}
          </button>
          <button type="button" className="part-chip" onClick={onStepBackwardStrideFrames}>
            -S
          </button>
          <button type="button" className="part-chip" onClick={onStepBackwardSingleFrame}>
            -1
          </button>
          <button type="button" className="part-chip" onClick={onStepForwardSingleFrame}>
            +1
          </button>
          <button type="button" className="part-chip" onClick={onStepForwardStrideFrames}>
            +S
          </button>
        </div>
        <label className="projection-slider">
          <span>Frame Step {frameStride}</span>
          <input
            type="range"
            min="1"
            max="8"
            step="1"
            value={frameStride}
            onChange={(event) => onFrameStrideChange(Number(event.currentTarget.value))}
          />
        </label>
        <button
          type="button"
          className={projectionSettings.enabled ? 'part-chip active' : 'part-chip'}
          onClick={() =>
            onProjectionSettingsChange({
              ...projectionSettings,
              enabled: !projectionSettings.enabled,
            })
          }
        >
          Overlay
        </button>
        <button
          type="button"
          className={projectionSettings.showContours ? 'part-chip active' : 'part-chip'}
          onClick={() =>
            onProjectionSettingsChange({
              ...projectionSettings,
              showContours: !projectionSettings.showContours,
            })
          }
        >
          Contours
        </button>
        <label className="projection-slider">
          <span>Simplify {projectionSettings.simplifyEpsilon.toFixed(1)}</span>
          <input
            type="range"
            min="0"
            max="24"
            step="0.5"
            value={projectionSettings.simplifyEpsilon}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                simplifyEpsilon: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-color-control">
          <span>Background</span>
          <input
            type="color"
            value={projectionSettings.backgroundColor}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                backgroundColor: event.currentTarget.value,
              })
            }
          />
        </label>
        <label className="projection-color-control">
          <span>Outline</span>
          <input
            type="color"
            value={projectionSettings.outlineColor}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                outlineColor: event.currentTarget.value,
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Outline Opacity {projectionSettings.outlineOpacity.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={projectionSettings.outlineOpacity}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                outlineOpacity: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Stroke {projectionSettings.strokeWidth.toFixed(1)}</span>
          <input
            type="range"
            min="0"
            max="8"
            step="0.25"
            value={projectionSettings.strokeWidth}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                strokeWidth: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Shadow {projectionSettings.shadowStrength.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={projectionSettings.shadowStrength}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                shadowStrength: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Highlight {projectionSettings.highlightStrength.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={projectionSettings.highlightStrength}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                highlightStrength: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Shadow Threshold {projectionSettings.shadowThreshold.toFixed(2)}</span>
          <input
            type="range"
            min="-1"
            max="0.8"
            step="0.05"
            value={projectionSettings.shadowThreshold}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                shadowThreshold: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Highlight Threshold {projectionSettings.highlightThreshold.toFixed(2)}</span>
          <input
            type="range"
            min="0.2"
            max="1"
            step="0.05"
            value={projectionSettings.highlightThreshold}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                highlightThreshold: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Edge Roughness {projectionSettings.edgeRoughness.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={projectionSettings.edgeRoughness}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                edgeRoughness: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Min Shape Area {projectionSettings.minShapeArea.toFixed(0)}</span>
          <input
            type="range"
            min="1"
            max="160"
            step="1"
            value={projectionSettings.minShapeArea}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                minShapeArea: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Global Shape Budget {projectionSettings.globalShapeBudget}</span>
          <input
            type="range"
            min="16"
            max="128"
            step="1"
            value={projectionSettings.globalShapeBudget}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                globalShapeBudget: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Merge Color {projectionSettings.mergeColorThreshold.toFixed(2)}</span>
          <input
            type="range"
            min="0.02"
            max="0.4"
            step="0.01"
            value={projectionSettings.mergeColorThreshold}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                mergeColorThreshold: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Temporal Stability {projectionSettings.temporalStability.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={projectionSettings.temporalStability}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                temporalStability: Number(event.currentTarget.value),
              })
            }
          />
        </label>
        <label className="projection-select">
          <span>Composition</span>
          <select
            value={projectionSettings.compositionMode}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                compositionMode: event.currentTarget.value as ProjectionOverlaySettings['compositionMode'],
              })
            }
          >
            <option value="vector">Vector</option>
            <option value="raster">Raster</option>
          </select>
        </label>
        <label className="projection-select">
          <span>Boundary Guard</span>
          <select
            value={projectionSettings.boundaryGuard}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                boundaryGuard: event.currentTarget.value as ProjectionOverlaySettings['boundaryGuard'],
              })
            }
          >
            <option value="outer">Outer Contour</option>
            <option value="outerDepthNormal">Outer + Depth/Normal</option>
            <option value="depthNormal">Depth/Normal</option>
            <option value="outerDepthNormalGap">Outer + Depth/Normal + Gap</option>
          </select>
        </label>
        <label className="projection-select">
          <span>Edge Smoothing</span>
          <select
            value={projectionSettings.edgeSmoothing}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                edgeSmoothing: event.currentTarget.value as ProjectionOverlaySettings['edgeSmoothing'],
              })
            }
          >
            <option value="hard">Hard</option>
            <option value="soft">Soft</option>
            <option value="open">Open</option>
          </select>
        </label>
        <details className="projection-advanced">
          <summary>Advanced / Experimental</summary>
          <label className="projection-check">
            <input
              type="checkbox"
              checked={projectionSettings.enableComposition}
              onChange={(event) =>
                onProjectionSettingsChange({
                  ...projectionSettings,
                  enableComposition: event.currentTarget.checked,
                })
              }
            />
            <span>Enable Composition</span>
          </label>
          <label className="projection-check">
            <input
              type="checkbox"
              checked={projectionSettings.enableShapeTracking}
              onChange={(event) =>
                onProjectionSettingsChange({
                  ...projectionSettings,
                  enableShapeTracking: event.currentTarget.checked,
                })
              }
            />
            <span>Enable Shape Tracking</span>
          </label>
          <label className="projection-check">
            <input
              type="checkbox"
              checked={projectionSettings.enableEdgeDistortion}
              onChange={(event) =>
                onProjectionSettingsChange({
                  ...projectionSettings,
                  enableEdgeDistortion: event.currentTarget.checked,
                })
              }
            />
            <span>Enable Edge Distortion</span>
          </label>
        </details>
        <label className="projection-slider">
          <span>Focal Budget {projectionSettings.focusShapeBudgets.focal}</span>
          <input
            type="range"
            min="4"
            max="48"
            step="1"
            value={projectionSettings.focusShapeBudgets.focal}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                focusShapeBudgets: {
                  ...projectionSettings.focusShapeBudgets,
                  focal: Number(event.currentTarget.value),
                },
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Support Budget {projectionSettings.focusShapeBudgets.support}</span>
          <input
            type="range"
            min="4"
            max="40"
            step="1"
            value={projectionSettings.focusShapeBudgets.support}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                focusShapeBudgets: {
                  ...projectionSettings.focusShapeBudgets,
                  support: Number(event.currentTarget.value),
                },
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Abstract Budget {projectionSettings.focusShapeBudgets.abstract}</span>
          <input
            type="range"
            min="2"
            max="24"
            step="1"
            value={projectionSettings.focusShapeBudgets.abstract}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                focusShapeBudgets: {
                  ...projectionSettings.focusShapeBudgets,
                  abstract: Number(event.currentTarget.value),
                },
              })
            }
          />
        </label>
        <label className="projection-slider">
          <span>Min Triangles {projectionSettings.minTriangleCount}</span>
          <input
            type="range"
            min="1"
            max="32"
            step="1"
            value={projectionSettings.minTriangleCount}
            onChange={(event) =>
              onProjectionSettingsChange({
                ...projectionSettings,
                minTriangleCount: Number(event.currentTarget.value),
              })
            }
          />
        </label>
      </div>
      <button
        type="button"
        className={selectedPartId === null ? 'part-chip active' : 'part-chip'}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      <div
        ref={listRef}
        className="part-list"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div className="part-list-spacer" style={{ height: `${totalHeight}px` }}>
          <div
            className="part-list-window"
            style={{ transform: `translateY(${startIndex * ROW_STRIDE}px)` }}
          >
        {renderedRows.map((row) => {
          const isCollapsed = collapsedPaths.has(row.path);
          return (
            <div key={row.path} className="part-row" style={{ paddingLeft: `${row.depth * 18}px` }}>
              <button
                type="button"
                className={row.hasChildren ? 'part-toggle' : 'part-toggle ghost'}
                onClick={row.hasChildren ? () => handleToggleCollapse(row.path) : undefined}
                aria-label={row.hasChildren ? `Toggle ${row.label}` : undefined}
              >
                {row.hasChildren ? (isCollapsed ? '+' : '-') : ''}
              </button>
              <button
                type="button"
                className={selectedPartId === row.id ? 'part-chip active' : 'part-chip'}
                onClick={() => onSelect(row.id)}
              >
                <span className="part-chip-label">
                  {row.swatchColor ? (
                    <span
                      className="part-swatch"
                      style={{ backgroundColor: row.swatchColor }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span>
                    {row.label}
                    {row.hasChildren ? ` (${row.childCount})` : ''}
                  </span>
                </span>
                <span>{row.triangleCount}</span>
              </button>
              {!row.hasChildren ? (
                <button
                  type="button"
                  className="part-focus-chip"
                  onClick={() => cyclePartFocus(row.id)}
                  title="Cycle focus override"
                >
                  {projectionSettings.partOverrides[row.id]?.focusLevel ?? 'auto'}
                </button>
              ) : null}
            </div>
          );
        })}
          </div>
        </div>
      </div>
      <div className="debug-panel">
        {debugMaterials.map((entry) => (
          <div key={entry.materialName} className="debug-item">
            <div>{entry.materialName}</div>
            <div>{entry.mapKind}</div>
            <div>{entry.mapFileName ?? '(no file)'}</div>
            <div>{entry.materialColor}</div>
            <div>
              {entry.imageWidth ?? '-'} x {entry.imageHeight ?? '-'}
            </div>
            <div>{entry.sampleColors.join(', ') || '(none)'}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default PartPanel;
