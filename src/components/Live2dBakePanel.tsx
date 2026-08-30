import { useRef, useState } from 'react';
import type { BakeSummary } from '../lib/live2d/bakeSummary';

type BuildProgress = (stage: 'samples' | 'textures', done: number, total: number, detail: string) => void;

type Live2dBakePanelProps = {
    onBuildLive2d: (onProgress: BuildProgress) => Promise<BakeSummary>;
};

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
            });
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
            <summary>Live2D Face Bake</summary>
            <div className="export-panel-body">
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
