import type {
  GameSettings,
  AutoPathData,
  PathLine,
  SequenceItem,
  PathPoint,
  Vec2,
  Alliance,
} from '../types';
import { START_POSES } from '../config';

/**
 * Match configuration — the pre-game options that belong to the MATCH, not the
 * robot: alliance, start position, practice dummies, and an imported auto path.
 * Lives on Home (game MODE is chosen by which play tile you click). Kept separate
 * from the My Robot loadout builder on purpose. `.pp` import + the Pedro-Pathing
 * → sim coordinate transform live here.
 */
export function MatchSetup({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') {
    alert(`${type.toUpperCase()}: ${message}`);
  }

  // --- Pedro Pathing (.pp) → sim coordinate transform ---
  const PP_FIELD_SIZE = 141.5;
  const PP_CENTER_OFFSET = PP_FIELD_SIZE / 2; // 70.75
  const SIM_FIELD_SIZE = 144; // From -72 to 72
  const SCALE_FACTOR = SIM_FIELD_SIZE / PP_FIELD_SIZE;

  function transformPpCoordinate(coord: Vec2): Vec2 {
    return {
      x: (coord.x - PP_CENTER_OFFSET) * SCALE_FACTOR,
      y: (coord.y - PP_CENTER_OFFSET) * SCALE_FACTOR,
    };
  }
  function transformPathPoint(pathPoint: PathPoint): PathPoint {
    const transformed = transformPpCoordinate(pathPoint);
    return { ...pathPoint, x: transformed.x, y: transformed.y };
  }

  function normalizeLines(input: PathLine[] = []): PathLine[] {
    return (input || []).map((line) => ({
      ...line,
      id: line.id || `line-${Math.random().toString(36).slice(2)}`,
      waitBeforeMs: Math.max(0, Number(line.waitBeforeMs ?? (line as any).waitBefore?.durationMs ?? 0)),
      waitAfterMs: Math.max(0, Number(line.waitAfterMs ?? (line as any).waitAfter?.durationMs ?? 0)),
      waitBeforeName: line.waitBeforeName ?? (line as any).waitBefore?.name ?? '',
      waitAfterName: line.waitAfterName ?? (line as any).waitAfter?.name ?? '',
      endPoint: transformPathPoint(line.endPoint),
      controlPoints: line.controlPoints?.map((cp) => transformPpCoordinate(cp)),
    }));
  }

  function deriveSequence(data: any, normalizedLines: PathLine[]): SequenceItem[] {
    if (Array.isArray(data?.sequence) && data.sequence.length) {
      return data.sequence as SequenceItem[];
    }
    return normalizedLines.map((ln) => ({ kind: 'path', lineId: ln.id! }));
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.pp')) {
      showToast('Please select a .pp file.', 'error');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        if (!data.startPoint || !data.lines) {
          throw new Error('Invalid file format: missing required fields (startPoint or lines)');
        }
        const transformedStartPoint = transformPathPoint(data.startPoint);
        const normalizedLines = normalizeLines(data.lines || []);
        const autoPathData: AutoPathData = {
          fileName: file.name,
          startPoint: transformedStartPoint,
          lines: normalizedLines,
          shapes:
            data.shapes?.map((s: any) => ({
              ...s,
              points: s.points?.map((p: Vec2) => transformPpCoordinate(p)),
              x: s.x !== undefined ? transformPpCoordinate({ x: s.x, y: 0 }).x : undefined,
              y: s.y !== undefined ? transformPpCoordinate({ x: 0, y: s.y }).y : undefined,
            })) || [],
          sequence: deriveSequence(data, normalizedLines),
          version: data.version,
          timestamp: data.timestamp,
        };
        set({ autoPath: autoPathData, autoPathEnabled: true });
        showToast(`Loaded auto path: ${file.name}`, 'success');
      } catch (error) {
        const errMsg = getErrorMessage(error);
        const message = errMsg.includes('Invalid file format')
          ? 'Invalid file format. This may not be a valid Pedro Pathing file.'
          : `Error loading file: ${errMsg}`;
        showToast(message, 'error');
        set({ autoPath: null, autoPathEnabled: false });
      } finally {
        event.target.value = '';
      }
    };
    reader.onerror = () => {
      showToast(`Failed to read file: ${reader.error?.message}`, 'error');
      event.target.value = '';
    };
    reader.readAsText(file);
  };

  const clearAutoPath = () => {
    set({ autoPath: null, autoPathEnabled: false });
    showToast('Auto path cleared.', 'info');
  };

  const setAlliance = (alliance: Alliance) => set({ alliance });

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Match setup</span>
        <span className="ds-panel-title" style={{ color: 'var(--ds-mut)' }}>
          applied when you start a match
        </span>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section className="ds-sec">
          <h2>Alliance</h2>
          <div className="ds-opts two">
            <button
              className={`ds-opt red ${settings.alliance === 'red' ? 'on' : ''}`}
              onClick={() => setAlliance('red')}
            >
              <span className="ot">RED</span>
              <span className="od">Red wall — your goal is cross-court, top-left of your view</span>
            </button>
            <button
              className={`ds-opt blue ${settings.alliance === 'blue' ? 'on' : ''}`}
              onClick={() => setAlliance('blue')}
            >
              <span className="ot">BLUE</span>
              <span className="od">Blue wall — your goal is cross-court, top-right of your view</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Start position</h2>
          <div className="ds-opts">
            {START_POSES.map((p, i) => (
              <button
                key={p.label}
                className={`ds-opt mini ${settings.startIndex === i ? 'on' : ''}`}
                onClick={() => set({ startIndex: i })}
              >
                <span className="ot">{p.label}</span>
                <span className="od">launch zone, mirrored to your alliance</span>
              </button>
            ))}
            <button
              className={`ds-opt mini ${settings.practiceDummies ? 'on' : ''}`}
              onClick={() => set({ practiceDummies: !settings.practiceDummies })}
            >
              <span className="ot">Practice dummies {settings.practiceDummies ? 'ON' : 'OFF'}</span>
              <span className="od">Three idle robots to push against (Free Drive)</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Auto path</h2>
          <div className="ds-opts">
            <label className="ds-opt" style={{ cursor: 'pointer' }}>
              <span className="ot">Import .pp file</span>
              <span className="od">{settings.autoPath ? settings.autoPath.fileName : 'No file selected'}</span>
              <input type="file" accept=".pp" onChange={handleFileChange} style={{ display: 'none' }} />
            </label>
            {settings.autoPath && (
              <button className="ds-opt" onClick={clearAutoPath}>
                <span className="ot">Clear path</span>
                <span className="od">Remove the loaded auto path</span>
              </button>
            )}
            <button
              className={`ds-opt ${settings.autoPathEnabled ? 'on' : ''}`}
              onClick={() => set({ autoPathEnabled: !settings.autoPathEnabled })}
              disabled={!settings.autoPath}
            >
              <span className="ot">Auto path {settings.autoPathEnabled ? 'ON' : 'OFF'}</span>
              <span className="od">Follow the imported path during auto</span>
            </button>
          </div>
          <p className="ds-hint">
            Build and export a <code>.pp</code> path at{' '}
            <a
              href="https://visualizer.pedropathing.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--ds-accent)' }}
            >
              visualizer.pedropathing.com
            </a>
            , then import it here.
            {settings.autoPath &&
              ` Loaded: ${settings.autoPath.fileName} (Version: ${settings.autoPath.version || 'N/A'}).`}
          </p>
        </section>
      </div>
    </div>
  );
}
