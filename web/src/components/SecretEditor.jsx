import { useState } from 'react';
import Field from './Field.jsx';
import { useSingleFlight } from '../hooks/useSingleFlight.js';

/**
 * A write-only secret (an API key, an access key): shows whether one is set,
 * lets an admin paste a new one or remove it after a confirmation. The value
 * is never read back from the server.
 *
 * `onSave(value)` stores the trimmed value; it is called with '' to remove it.
 */
export default function SecretEditor({
  label, hint, present, onSave, inputLabel, placeholder, removeConfirm,
  autoEdit = false, addText = 'Add key',
}) {
  const [editing, setEditing] = useState(autoEdit && !present);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState(null);
  // One save/remove at a time: Enter pressed twice or a double click can't
  // send a second request.
  const [busy, run] = useSingleFlight();

  function cancel() { setEditing(false); setValue(''); }
  function save() {
    const next = value.trim();
    // An empty value would remove the key: that only happens via Remove.
    if (!next) return undefined;
    return run(async () => {
      setErr(null);
      try { await onSave(next); cancel(); }
      catch (e) { setErr(e?.message || 'Failed to save.'); }
    });
  }
  function remove() {
    return run(async () => {
      if (!window.confirm(removeConfirm)) return;
      setErr(null);
      try { await onSave(''); cancel(); }
      catch (e) { setErr(e?.message || 'Failed to remove.'); }
    });
  }
  function onKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') cancel();
  }

  return (
    <Field label={label} hint={err ? undefined : hint}>
      {!editing ? (
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium px-2.5 py-1.5 rounded-sm ${present ? 'text-accent bg-accent-soft' : 'text-warn bg-warn-soft'}`}>
            <span style={{ width: 6, height: 6, borderRadius: 6, background: 'currentColor' }} />
            {present ? 'Key set' : 'No key'}
          </span>
          <button type="button" onClick={() => setEditing(true)} className="btn btn-ghost !py-1.5">{present ? 'Replace' : addText}</button>
          {present && <button type="button" onClick={remove} disabled={busy} className="btn btn-ghost !py-1.5 !text-error">Remove</button>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={reveal ? 'text' : 'password'} value={value} autoFocus aria-label={inputLabel}
              onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown}
              placeholder={placeholder} autoComplete="off" className="input !pr-10" />
            <button type="button" onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide the value' : 'Show the value'}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink text-xs">{reveal ? 'Hide' : 'Show'}</button>
          </div>
          <button type="button" onClick={save} disabled={!value.trim() || busy} className="btn btn-primary !py-2">{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={cancel} disabled={busy} className="btn btn-ghost !py-2">Cancel</button>
        </div>
      )}
      {err && <p className="text-xs text-error mt-1.5" role="alert">{err}</p>}
    </Field>
  );
}
