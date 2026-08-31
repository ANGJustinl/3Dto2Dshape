import { useRef, useState } from 'react';
import type { BakeSummary } from '../lib/live2d/bakeSummary';
import { PIPELINE_VERSION } from '../lib/live2d/build';

type BuildProgress = (stage: 'samples' | 'textures', done: number, total: number, detail: string) => void;

type Live2dBakePanelProps = {
    onBuildLive2d: (onProgress: BuildProgress, textureScale: number) => Promise<BakeSummary>;
};

const TEXTURE_SCALE_OPTIONS = [
    { scale: 1, label: 'Standard 2048' },
    { scale: 2, label: 'HD 4096' },
    { scale: 3, label: 'Ultra 6144' },
];

type BakeProgress = {
    stage: string;
    done: number;
    total: number;
    detail: string;
};

const Live2dBakePanel = ({ onBuildLive2d }: Live2dBakePanelProps) => {
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<BakeProgress | null>(null);
    const [summary, setSummary] = useState<BakeSummary | null>(null);
    const [elapsedMs, setElapsedMs] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [textureScale, setTextureScale] = useState(2);
    const runningRef = useRef(false);

    const handleBuild = async () => {
        if (runningRef.current) {
            return;
        }
        runningRef.current = true;
        setRunning(true);
        setError(null);
        setSummary(null);
        setElapsedMs(null);
        setProgress(null);
        const startedAt = performance.now();
        try {
            const result = await onBuildLive2d((stage, done, total, detail) => {
                setProgress({ stage, done, total, detail });
            }, textureScale);
            setSummary(result);
            setElapsedMs(performance.now() - startedAt);
        } catch (buildError) {
            setError(buildError instanceof Error ? buildError.message : String(buildError));
        } finally {
            runningRef.current = false;
            setRunning(false);
        }
    };

    const downloadSummary = () => {
        if (!summary) {
            return;
        }
        const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'face-bake-summary.json';
        anchor.click();
        URL.revokeObjectURL(url);
    };

    return (
        <details className="export-panel" open>
            <summary>Live2D Face Bake (pipeline {PIPELINE_VERSION})</summary>
            <div className="export-panel-body">
                <div className="export-hint">
                    <div>Texture resolution (bake time scales with resolution)</div>
                    {TEXTURE_SCALE_OPTIONS.map((option) => (
                        <button
                            key={option.scale}
                            type="button"
                            className={option.scale === textureScale ? 'part-chip active' : 'part-chip'}
                            onClick={() => setTextureScale(option.scale)}
                            disabled={running}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    className="part-chip active"
                    onClick={handleBuild}
                    disabled={running}
                >
                    {running ? 'Building…' : 'Bake & build model'}
                </button>
                {running && progress ? (
                    <div className="export-progress">
                        {progress.stage} {progress.done}/{progress.total} — {progress.detail}
                    </div>
                ) : null}
                {summary ? (
                    <div className="export-hint">
                        <div>
                            {summary.sampleCounts.total} samples ({summary.sampleCounts.familySweep} sweep,{' '}
                            {summary.sampleCounts.comboQa} combo) in {((elapsedMs ?? 0) / 1000).toFixed(1)}s
                        </div>
                        <div>
                            Resolved: {summary.resolvedParams.join(', ') || 'none'}
                            {summary.unresolvedParams.length > 0
                                ? ` — missing: ${summary.unresolvedParams.join(', ')}`
                                : ''}
                        </div>
                        {Object.entries(summary.movingLeafCountByFamily).map(([family, movingParts]) => (
                            <div key={family}>
                                {family}: {movingParts} moving parts
                            </div>
                        ))}
                        <button type="button" className="part-chip" onClick={downloadSummary}>
                            Download summary
                        </button>
                    </div>
                ) : null}
                {error ? <div className="export-error">{error}</div> : null}
            </div>
        </details>
    );
};

export default Live2dBakePanel;
