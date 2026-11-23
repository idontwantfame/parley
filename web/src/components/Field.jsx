import { Children, cloneElement, isValidElement, useId } from 'react';

const LABELABLE = new Set(['input', 'select', 'textarea']);

/**
 * Form field with a visible label that is programmatically tied to its
 * control, so screen readers announce it. A single native input, select or
 * textarea child gets `htmlFor`/`id`; anything else (e.g. a custom picker) is
 * exposed as a group labelled by the visible text.
 */
export default function Field({ label, hint, children }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const only = Children.count(children) === 1 && isValidElement(children) ? children : null;
  const native = only && typeof only.type === 'string' && LABELABLE.has(only.type);
  const hintEl = hint && <p id={hintId} className="text-xs text-muted mt-1.5">{hint}</p>;

  if (native) {
    const controlId = only.props.id ?? id;
    return (
      <div>
        <label htmlFor={controlId} className="block text-[13px] font-medium text-ink mb-1.5">{label}</label>
        {cloneElement(only, { id: controlId, 'aria-describedby': only.props['aria-describedby'] ?? hintId })}
        {hintEl}
      </div>
    );
  }

  const labelId = `${id}-label`;
  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={hintId}>
      <span id={labelId} className="block text-[13px] font-medium text-ink mb-1.5">{label}</span>
      {children}
      {hintEl}
    </div>
  );
}
