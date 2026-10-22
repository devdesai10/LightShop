import { useEffect, useState } from 'react';
import { Images, Layers, SlidersHorizontal, Upload } from 'lucide-react';
import { Module, app, importFiles, initApp, isImportable, setModule } from './state/app';
import { storageEstimate } from './lib/db';
import { formatBytes, modKey } from './lib/util';
import { Button, cx } from './ui/controls';
import { LibraryView, promptImport } from './library/LibraryView';
import { DevelopView } from './develop/DevelopView';
import { EditorView } from './editor/EditorView';
import { editor, enterEditor, openFilesInEditor } from './editor/session';
import { DialogHost } from './ui/dialogs';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { preventPageZoom } from './lib/gestures';

const MODULES: { id: Module; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'library', label: 'Library', hint: 'Organize, rate and filter (⌥⌘1)', icon: <Images size={15} /> },
  { id: 'develop', label: 'Develop', hint: 'Non-destructive RAW-style editing (⌥⌘2)', icon: <SlidersHorizontal size={15} /> },
  { id: 'editor', label: 'Editor', hint: 'Layers, brushes, selections and retouching (⌥⌘3)', icon: <Layers size={15} /> },
];

/** Module switch; entering the Editor from Develop brings the photo being developed along. */
function goToModule(id: Module) {
  if (id === 'editor' && app.get().module !== 'editor') enterEditor();
  else setModule(id);
}

function TopBar() {
  const module = app.use((s) => s.module);
  const count = app.use((s) => s.photos.length);
  const docs = editor.use((s) => s.docs.length);
  const [usage, setUsage] = useState<string>('');
  useEffect(() => {
    storageEstimate().then((e) => e && setUsage(`${formatBytes(e.usage)} used`));
  }, [count]);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        LightShop
      </div>
      <nav className="modules" aria-label="Modules">
        {MODULES.map((m) => (
          <button key={m.id} className={cx(module === m.id && 'active')} onClick={() => goToModule(m.id)} title={m.hint} aria-current={module === m.id ? 'page' : undefined}>
            {m.icon}
            {m.label}
            {m.id === 'editor' && docs > 0 && <span className="count">{docs}</span>}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <span className="status">
        {count} photo{count === 1 ? '' : 's'}
        {usage && ` · ${usage}`}
      </span>
      <Button small onClick={promptImport} title="Import photos (or drop files on the window)">
        <Upload size={14} /> Import
      </Button>
    </header>
  );
}

function Toasts() {
  const toasts = app.use((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function ImportProgress() {
  const p = app.use((s) => s.importing);
  if (!p) return null;
  return (
    <div className="progress" role="progressbar" aria-valuenow={p.done} aria-valuemax={p.total}>
      Importing {p.done + 1} of {p.total}
      <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.current}
      </div>
      <div className="progress-bar">
        <div style={{ width: `${(p.done / p.total) * 100}%` }} />
      </div>
    </div>
  );
}

export default function App() {
  const ready = app.use((s) => s.ready);
  const module = app.use((s) => s.module);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initApp().catch((e) => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer!.files);
      if (app.get().module === 'editor') openFilesInEditor(files);
      else importFiles(files.filter(isImportable));
    };
    const keys = (e: KeyboardEvent) => {
      // e.code: with Option held, e.key is a symbol (¡ ™ £) on macOS layouts.
      const digit = /^Digit([123])$/.exec(e.code)?.[1] ?? (['1', '2', '3'].includes(e.key) ? e.key : null);
      if (modKey(e) && e.altKey && digit) {
        e.preventDefault();
        goToModule(MODULES[+digit - 1].id);
      }
    };
    // Editor documents live in memory until saved to the Library; warn before losing them.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (editor.get().docs.some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    // Pinches zoom the photo views (or resize the grid), never the whole window in a browser.
    const allowPageZoom = preventPageZoom();
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('keydown', keys);
      window.removeEventListener('beforeunload', beforeUnload);
      allowPageZoom();
    };
  }, []);

  if (error)
    return (
      <div className="empty">
        <h3>LightShop could not start</h3>
        <div>{error}</div>
      </div>
    );

  return (
    <div className="app">
      <TopBar />
      <div style={{ minHeight: 0, position: 'relative' }}>
        {!ready ? (
          <div className="empty">Loading catalog…</div>
        ) : (
          <ErrorBoundary key={module} area={MODULES.find((m) => m.id === module)?.label ?? 'LightShop'} onLeave={module === 'library' ? undefined : () => setModule('library')}>
            {module === 'library' ? <LibraryView /> : module === 'develop' ? <DevelopView /> : <EditorView />}
          </ErrorBoundary>
        )}
      </div>
      {dragging && <div className="drop-overlay">{module === 'editor' ? 'Drop to open in the Editor' : 'Drop to import into the Library'}</div>}
      <ImportProgress />
      <Toasts />
      <DialogHost />
    </div>
  );
}
