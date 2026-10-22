import { useState } from 'react';
import { ExportFormat, ExportOptions, FORMAT_INFO, canPickFolder, exportPhotos } from '../develop/export';
import { toast } from '../state/app';
import { Button, Field, Modal, NumberInput, Segmented } from './controls';

const KEY = 'ls.export';

export function ExportDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [opts, setOpts] = useState<ExportOptions>(() => {
    try {
      return { format: 'jpeg', quality: 90, longEdge: null, suffix: '', toFolder: canPickFolder(), ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    } catch {
      return { format: 'jpeg', quality: 90, longEdge: null, suffix: '', toFolder: canPickFolder() };
    }
  });
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const set = (p: Partial<ExportOptions>) => setOpts((o) => ({ ...o, ...p }));

  const run = async () => {
    localStorage.setItem(KEY, JSON.stringify(opts));
    setBusy({ done: 0, total: ids.length });
    try {
      const n = await exportPhotos(ids, opts, (done, total) => setBusy({ done, total }));
      if (n) toast(`Exported ${n} photo${n === 1 ? '' : 's'}`, 'success');
      onClose();
    } catch (e) {
      console.error(e);
      toast(`Export failed: ${(e as Error).message}`, 'error', 6000);
      setBusy(null);
    }
  };

  return (
    <Modal
      title={`Export ${ids.length} photo${ids.length === 1 ? '' : 's'}`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button primary onClick={run} disabled={!!busy || !ids.length}>
            {busy ? `Exporting ${busy.done + 1}/${busy.total}…` : 'Export'}
          </Button>
        </>
      }
    >
      <Field label="Format">
        <Segmented<ExportFormat>
          value={opts.format}
          onChange={(format) => set({ format })}
          options={(Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => ({ value: f, label: FORMAT_INFO[f].label }))}
        />
      </Field>
      {opts.format !== 'png' && (
        <Field label={`Quality (${opts.quality})`}>
          <input type="range" min={10} max={100} value={opts.quality} onChange={(e) => set({ quality: +e.target.value })} aria-label="Quality" />
        </Field>
      )}
      <Field label="Resize long edge">
        <div className="row">
          <input type="checkbox" checked={opts.longEdge !== null} onChange={(e) => set({ longEdge: e.target.checked ? 2048 : null })} aria-label="Limit size" />
          {opts.longEdge !== null && <NumberInput value={opts.longEdge} min={64} max={16384} onChange={(v) => set({ longEdge: Math.round(v) })} ariaLabel="Long edge pixels" />}
          <span className="muted">{opts.longEdge === null ? 'Full size' : 'px'}</span>
        </div>
      </Field>
      <Field label="File name suffix">
        <input className="text-input" value={opts.suffix} placeholder="e.g. -web" onChange={(e) => set({ suffix: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      <Field label="Destination">
        <Segmented<string>
          value={opts.toFolder ? 'folder' : 'downloads'}
          onChange={(v) => set({ toFolder: v === 'folder' })}
          options={[
            ...(canPickFolder() ? [{ value: 'folder', label: 'Choose folder…' }] : []),
            { value: 'downloads', label: 'Downloads' },
          ]}
        />
      </Field>
      <p className="hint">Develop settings, crop and effects are rendered at full resolution. Originals in the catalog are never modified.</p>
    </Modal>
  );
}
