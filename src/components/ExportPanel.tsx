import { useEffect, useMemo, useRef, useState } from 'react';
import {
    getSupportedExportFormats,
    isDeterministicExportAvailable,
    type ExportVideoFormat,
    type ExportVideoSettings,
    type ExportVideoSource,
} from '../lib/export/videoExporter';

type ExportPanelProps = {
    animationFrameCount: number;
    onExportVideo: (
        settings: ExportVideoSettings,
        onProgress: (completed: number, total: number) => void,
        signal: AbortSignal,
    ) => Promise<void>;
};

const DEFAULT_FPS = 30;

function ExportPanel({ animationFrameCount, onExportVideo }: ExportPanelProps) {
    const supportedFormats = useMemo(() => getSupportedExportFormats(), []);
    const deterministicExport = useMemo(() => isDeterministicExportAvailable(), []);
    const [source, setSource] = useState<ExportVideoSource>('overlay2d');
    const [format, setFormat] = useState<ExportVideoFormat>(supportedFormats[0] ?? 'webm');
    const [fps, setFps] = useState(DEFAULT_FPS);
    const [startFrame, setStartFrame] = useState(0);
    const [endFrame, setEndFrame] = useState(Math.max(0, animationFrameCount - 1));
    const [frameStep, setFrameStep] = useState(1);
    const [scale, setScale] = useState(1);
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState({ completed: 0, total: 0 });
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        setEndFrame((current) =>
            current === 0 && animationFrameCount > 1
                ? animationFrameCount - 1
                : Math.min(current, Math.max(0, animationFrameCount - 1)),
        );
    }, [animationFrameCount]);

    useEffect(() => {
        if (supportedFormats.length > 0 && !supportedFormats.includes(format)) {
            setFormat(supportedFormats[0]);
        }
    }, [format, supportedFormats]);

    const handleExport = async () => {
        if (isExporting || supportedFormats.length === 0) {
            return;
        }

        const maxFrame = Math.max(0, animationFrameCount - 1);
        const safeStart = Math.max(
            0,
            Math.min(Number.isFinite(startFrame) ? Math.floor(startFrame) : 0, maxFrame),
        );
        const safeEnd = Math.max(
            safeStart,
            Math.min(Number.isFinite(endFrame) ? Math.floor(endFrame) : maxFrame, maxFrame),
        );
        const controller = new AbortController();
        abortRef.current = controller;
        setIsExporting(true);
        setError(null);
        setProgress({ completed: 0, total: 0 });
        try {
            await onExportVideo(
                {
                    source,
                    format,
                    fps,
                    startFrame: safeStart,
                    endFrame: safeEnd,
                    frameStep: Math.max(1, frameStep),
                    scale,
                },
                (completed, total) => setProgress({ completed, total }),
                controller.signal,
            );
        } catch (exportError) {
            if (!(exportError instanceof DOMException && exportError.name === 'AbortError')) {
                setError(exportError instanceof Error ? exportError.message : String(exportError));
            }
        } finally {
            abortRef.current = null;
            setIsExporting(false);
        }
    };

    return (
        <details className="export-panel" open>
            <summary>Export Video</summary>
            <div className="export-panel-body">
                <label className="projection-select">
                    <span>Source</span>
                    <select value={source} onChange={(event) => setSource(event.currentTarget.value as ExportVideoSource)}>
                        <option value="overlay2d">2D Result</option>
                        <option value="model3d">3D View</option>
                        <option value="sideBySide">3D + 2D</option>
                    </select>
                </label>
                <label className="projection-select">
                    <span>Format</span>
                    <select
                        value={format}
                        disabled={supportedFormats.length === 0 || isExporting}
                        onChange={(event) => setFormat(event.currentTarget.value as ExportVideoFormat)}
                    >
                        <option value="webm" disabled={!supportedFormats.includes('webm')}>WebM</option>
                        <option value="mp4" disabled={!supportedFormats.includes('mp4')}>
                            MP4{supportedFormats.includes('mp4') ? '' : ' (unsupported)'}
                        </option>
                    </select>
                </label>
                <div className="export-grid-2">
                    <label className="projection-select">
                        <span>FPS</span>
                        <select value={fps} onChange={(event) => setFps(Number(event.currentTarget.value))}>
                            {[12, 24, 30, 60].map((value) => (
                                <option key={value} value={value}>{value}</option>
                            ))}
                        </select>
                    </label>
                    <label className="projection-select">
                        <span>Frame Step</span>
                        <select value={frameStep} onChange={(event) => setFrameStep(Number(event.currentTarget.value))}>
                            {[1, 2, 3, 4, 5, 8, 10].map((value) => (
                                <option key={value} value={value}>{value}</option>
                            ))}
                        </select>
                    </label>
                </div>
                <div className="export-grid-2">
                    <label className="projection-select">
                        <span>Start Frame</span>
                        <input
                            type="number"
                            min="0"
                            max={Math.max(0, animationFrameCount - 1)}
                            value={startFrame}
                            onChange={(event) => setStartFrame(Number(event.currentTarget.value))}
                        />
                    </label>
                    <label className="projection-select">
                        <span>End Frame</span>
                        <input
                            type="number"
                            min="0"
                            max={Math.max(0, animationFrameCount - 1)}
                            value={endFrame}
                            onChange={(event) => setEndFrame(Number(event.currentTarget.value))}
                        />
                    </label>
                </div>
                <label className="projection-select">
                    <span>Resolution</span>
                    <select value={scale} onChange={(event) => setScale(Number(event.currentTarget.value))}>
                        <option value="0.5">50%</option>
                        <option value="1">100%</option>
                        <option value="1.5">150%</option>
                        <option value="2">200%</option>
                    </select>
                </label>
                {isExporting ? (
                    <div className="export-progress">
                        <span>
                            Exporting {progress.completed}/{progress.total || '…'}
                        </span>
                        <button type="button" className="part-chip" onClick={() => abortRef.current?.abort()}>
                            Cancel
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        className="part-chip active"
                        disabled={supportedFormats.length === 0}
                        onClick={() => void handleExport()}
                    >
                        {supportedFormats.length === 0 ? 'Video Export Unsupported' : 'Export Video'}
                    </button>
                )}
                {error ? <div className="export-error">{error}</div> : null}
                <div className="export-hint">
                    {supportedFormats.length === 0
                        ? 'This browser does not expose MediaRecorder canvas capture.'
                        : deterministicExport
                          ? 'WebCodecs export uses exact frame timestamps; playback duration follows sampled frames / FPS.'
                          : 'Compatibility export uses real-time MediaRecorder capture and may take longer for heavy frames.'}
                </div>
            </div>
        </details>
    );
}

export default ExportPanel;
