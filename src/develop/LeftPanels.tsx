import { useEffect, useRef } from 'react';
import { Download, Plus, Upload, X } from 'lucide-react';
import { app, deletePreset, savePreset, toast } from '../state/app';
import { downloadBlob, pickFiles, uid } from '../lib/util';
import { exportXmpPreset, parsePresetFile } from '../lib/xmp';
import { IconButton, Panel, cx } from '../ui/controls';
import { confirmDialog, promptText } from '../ui/dialogs';
import { BUILTIN_PRESETS, Preset, applyPatch, lookOnly } from './settings';
import { commitSettings, dev, jumpHistory, navigateTo } from './state';

/** Whole-photo preview. When zoomed in it outlines the visible area; click or drag to move around. */
export function NavigatorPanel() {
  const img = dev.use((s) => s.navigator);
  const rect = dev.use((s) => s.viewRect);
  const ref = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
  }, [img]);
  const go = (e: React.PointerEvent, zoomIfFit: boolean) => {
    const b = e.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    navigateTo(clamp((e.clientX - b.left) / b.width), clamp((e.clientY - b.top) / b.height), zoomIfFit);
  };
  return (
    <Panel title="Navigator" id="dev-nav">
      <div className="navigator">
        {img ? (
          <div
            className="nav-frame"
            title={rect ? 'Drag to move around the photo' : 'Click to zoom in on a spot'}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              dragging.current = true;
              go(e, true);
            }}
            onPointerMove={(e) => dragging.current && go(e, false)}
            onPointerUp={() => (dragging.current = false)}
            onPointerCancel={() => (dragging.current = false)}
          >
            <canvas ref={ref} />
            {rect && (
              <div
                className="nav-rect"
                style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
              />
            )}
          </div>
        ) : (
          <div className="hint">Loading…</div>
        )}
      </div>
    </Panel>
  );
}

export function PresetsPanel() {
  const user = app.use((s) => s.presets);
  const all = [...BUILTIN_PRESETS, ...user];
  const groups = [...new Set(all.map((p) => p.group))];

  const apply = (p: Preset) => {
    dev.set({ preview: null });
    commitSettings(`Preset: ${p.name}`, applyPatch(dev.get().settings, p.patch));
  };
  const saveCurrent = async () => {
    const name = await promptText('Save preset', 'My preset', { message: 'Saves the current look (not crop or masks) as a preset.', okLabel: 'Save' });
    if (!name?.trim()) return;
    await savePreset({ id: uid('u'), name: name.trim(), group: 'User Presets', patch: lookOnly(dev.get().settings) });
    toast(`Saved preset "${name}"`, 'success');
  };
  const importFiles = async () => {
    const files = await pickFiles('.xmp,.lrtemplate', true);
    let n = 0;
    for (const f of files) {
      const parsed = parsePresetFile(f.name, await f.text());
      if (!parsed) continue;
      await savePreset({ id: uid('u'), name: parsed.name, group: parsed.group === 'Imported' ? 'Imported' : `Imported · ${parsed.group}`, patch: parsed.patch });
      n++;
    }
    if (files.length) toast(n ? `Imported ${n} preset${n === 1 ? '' : 's'}` : 'No develop settings found in those files', n ? 'success' : 'error');
  };
  const exportCurrent = async () => {
    const name = await promptText('Export XMP preset', 'LightShop preset', { message: 'Exports the current settings as a Lightroom-compatible .xmp preset.', okLabel: 'Export' });
    if (!name?.trim()) return;
    const xml = exportXmpPreset(name, dev.get().settings);
    downloadBlob(new Blob([xml], { type: 'application/rdf+xml' }), `${name.replace(/[^\w\- ]+/g, '_')}.xmp`);
  };

  return (
    <Panel
      title="Presets"
      id="dev-presets"
      actions={
        <>
          <IconButton title="Import Lightroom presets (.xmp, .lrtemplate)" onClick={importFiles}>
            <Upload size={13} />
          </IconButton>
          <IconButton title="Export current settings as .xmp" onClick={exportCurrent}>
            <Download size={13} />
          </IconButton>
          <IconButton title="Save current look as preset" onClick={saveCurrent}>
            <Plus size={14} />
          </IconButton>
        </>
      }
    >
      {groups.map((g) => (
        <div className="preset-group" key={g}>
          <div className="preset-group-title">{g}</div>
          {all
            .filter((p) => p.group === g)
            .map((p) => (
              <div
                key={p.id}
                className="preset"
                onMouseEnter={() => dev.set({ preview: p })}
                onMouseLeave={() => dev.get().preview?.id === p.id && dev.set({ preview: null })}
                onClick={() => apply(p)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && apply(p)}
              >
                {p.name}
                {!p.builtin && (
                  <button
                    className="x"
                    title="Delete preset"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await confirmDialog('Delete preset', `Delete the preset "${p.name}"?`, { okLabel: 'Delete', danger: true })) deletePreset(p.id);
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
        </div>
      ))}
      <div className="hint">Hover to preview, click to apply. Lightroom presets are approximated with LightShop's own processing.</div>
    </Panel>
  );
}

export function HistoryPanel() {
  const history = dev.use((s) => s.history);
  const idx = dev.use((s) => s.hIndex);
  return (
    <Panel title="History" id="dev-history">
      <ul className="history-list">
        {history
          .map((h, i) => ({ h, i }))
          .reverse()
          .map(({ h, i }) => (
            <li key={i} className={cx(i === idx && 'current', i > idx && 'future')} onClick={() => jumpHistory(i)}>
              {h.label}
            </li>
          ))}
      </ul>
    </Panel>
  );
}
