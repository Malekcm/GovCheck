import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { SET_ASIDE_LABELS } from '../../shared/domain';
import { ListInput } from './ui';
import { cleanArguments, coerce, dateValue, fieldsOf, missingRequired, NAICS_CODE, type Field, type JsonSchema } from './schemaFields';

/**
 * A form generated from a G2X tool's live input schema. Every field becomes a dropdown, checkbox,
 * date picker, number box or picker; the arguments JSON is produced automatically. Power users can
 * still open "Edit as JSON".
 */
export function SchemaForm({ schema, value, onChange }: { schema: JsonSchema | undefined; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const set = (name: string, v: unknown) => {
    const next = { ...value };
    if (cleanArguments(v) === undefined) delete next[name];
    else next[name] = v;
    onChange(next);
  };
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);
  const missing = missingRequired(fields, value);
  if (!fields.length)
    return (
      <p className="small muted">
        This tool takes no inputs.
      </p>
    );
  return (
    <div className="stack">
      {required.length > 0 && (
        <div className="form-grid">
          {required.map((f) => (
            <FieldInput key={f.name} field={f} value={value[f.name]} onChange={(v) => set(f.name, v)} />
          ))}
        </div>
      )}
      {optional.length > 0 && (
        <div className="form-grid">
          {optional.map((f) => (
            <FieldInput key={f.name} field={f} value={value[f.name]} onChange={(v) => set(f.name, v)} />
          ))}
        </div>
      )}
      {missing.length > 0 && <p className="small" style={{ color: 'var(--bad)' }}>Required: {missing.join(', ')}</p>}
      <details
        open={jsonOpen}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          setJsonOpen(open);
          if (open) setDraft(JSON.stringify(cleanArguments(value) ?? {}, null, 2));
        }}
      >
        <summary className="small muted">Edit as JSON</summary>
        <textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ fontFamily: 'var(--mono)', marginTop: 6 }} />
        {jsonError && <p className="small" style={{ color: 'var(--bad)' }}>{jsonError}</p>}
        <div className="row">
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              try {
                const parsed = JSON.parse(draft || '{}');
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The arguments must be a JSON object.');
                setJsonError(null);
                onChange(parsed);
              } catch (e) {
                setJsonError(e instanceof SyntaxError ? 'That is not valid JSON.' : (e as Error).message);
              }
            }}
          >
            Apply JSON to form
          </button>
          <span className="small muted">Changes you make in the form above update this when you reopen it.</span>
        </div>
      </details>
    </div>
  );
}

function Label({ field, children, wide }: { field: Field; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)', fontWeight: 500, gridColumn: wide ? '1 / -1' : undefined }}>
      <span>
        {field.label}
        {field.required && <span style={{ color: 'var(--bad)' }}> *</span>}
      </span>
      {children}
      {field.help && <span className="small muted" style={{ fontWeight: 400 }}>{field.help}</span>}
    </div>
  );
}

function FieldInput({ field: f, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  switch (f.kind) {
    case 'naics':
      return (
        <Label field={f} wide={f.multiple}>
          <NaicsPicker field={f} values={list} onChange={(vals) => onChange(f.multiple ? vals : vals[vals.length - 1])} />
        </Label>
      );
    case 'agency':
      return (
        <Label field={f} wide={f.multiple}>
          <AgencyPicker field={f} values={list.map(String)} onChange={(vals) => onChange(f.multiple ? vals : vals[vals.length - 1])} />
        </Label>
      );
    case 'set_aside':
      return (
        <Label field={f} wide={f.multiple}>
          <SuggestList
            values={list.map(String)}
            multiple={f.multiple}
            maxItems={f.maxItems}
            placeholder="Choose or type a set-aside"
            options={Object.entries(SET_ASIDE_LABELS).map(([code, label]) => ({ value: code, label }))}
            describe={(v) => SET_ASIDE_LABELS[v]}
            onChange={(vals) => onChange(f.multiple ? vals : vals[vals.length - 1])}
          />
        </Label>
      );
    case 'enum':
      return (
        <Label field={f}>
          <select
            value={value === undefined ? '' : JSON.stringify(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : JSON.parse(e.target.value))}
          >
            <option value="">{f.required ? 'Choose…' : 'Any'}</option>
            {f.options.map((o) => (
              <option key={JSON.stringify(o.value)} value={JSON.stringify(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        </Label>
      );
    case 'multi_enum':
      return (
        <Label field={f} wide>
          <div className="chips">
            {f.options.map((o) => {
              const on = list.some((v) => JSON.stringify(v) === JSON.stringify(o.value));
              const full = !on && f.maxItems != null && list.length >= f.maxItems;
              return (
                <button
                  type="button"
                  key={JSON.stringify(o.value)}
                  className={`chip${on ? ' on' : ''}`}
                  disabled={full}
                  onClick={() => onChange(on ? list.filter((v) => JSON.stringify(v) !== JSON.stringify(o.value)) : [...list, o.value])}
                >
                  {on ? '✓ ' : ''}
                  {o.label}
                </button>
              );
            })}
          </div>
        </Label>
      );
    case 'boolean':
      return (
        <Label field={f}>
          <select value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}>
            <option value="">{f.schema.default !== undefined ? `Default (${f.schema.default ? 'yes' : 'no'})` : 'Not set'}</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </Label>
      );
    case 'integer':
    case 'number':
      return (
        <Label field={f}>
          <input
            type="number"
            min={f.min}
            max={f.max}
            step={f.kind === 'integer' ? 1 : 'any'}
            placeholder={f.placeholder ?? (f.min != null || f.max != null ? `${f.min ?? ''}–${f.max ?? ''}` : '')}
            value={value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : coerce(e.target.value, f.kind === 'integer' ? 'integer' : 'number'))}
          />
        </Label>
      );
    case 'date':
      return (
        <Label field={f}>
          <input type="date" value={typeof value === 'string' ? value.slice(0, 10) : ''} onChange={(e) => onChange(e.target.value ? dateValue(e.target.value, f.dateTime) : undefined)} />
        </Label>
      );
    case 'string_list':
      return (
        <Label field={f} wide>
          <ListInput value={list.map(String)} onChange={(vals) => onChange(vals.map((v) => coerce(v, f.valueType)))} placeholder={f.placeholder ?? 'Type and press Enter'} />
        </Label>
      );
    case 'object':
      return (
        <Label field={f} wide>
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 10 }}>
            <SchemaForm schema={f.schema} value={(value as Record<string, unknown>) ?? {}} onChange={(v) => onChange(v)} />
          </div>
        </Label>
      );
    case 'json':
      return (
        <Label field={f} wide>
          <JsonField value={value} onChange={onChange} />
        </Label>
      );
    default:
      return (
        <Label field={f} wide={/^(query|q|keywords?|search|text)$/i.test(f.name)}>
          <input type="text" maxLength={f.schema.maxLength} placeholder={f.placeholder ?? ''} value={typeof value === 'string' ? value : value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value)} />
        </Label>
      );
  }
}

function JsonField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value));
  const [bad, setBad] = useState(false);
  return (
    <>
      <input
        type="text"
        value={text}
        style={{ fontFamily: 'var(--mono)', borderColor: bad ? 'var(--bad)' : undefined }}
        placeholder="JSON value"
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) return setBad(false), onChange(undefined);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------
type Option = { value: string; label: string; hint?: string };

function useDebounced<T>(v: T, ms = 200) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Chips + a type-ahead box. Free text is allowed (Enter adds what you typed) unless `validate` rejects it. */
function SuggestList({
  values,
  onChange,
  options,
  multiple,
  maxItems,
  placeholder,
  query,
  onQuery,
  validate,
  quick,
  describe,
  loading,
  emptyHint,
}: {
  loading?: boolean;
  emptyHint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: Option[];
  multiple: boolean;
  maxItems?: number;
  placeholder: string;
  query?: string;
  onQuery?: (q: string) => void;
  validate?: (typed: string) => string | null;
  quick?: { label: string; values: string[] };
  describe?: (v: string) => string | undefined;
}) {
  const [local, setLocal] = useState('');
  const text = query ?? local;
  const setText = (s: string) => (onQuery ? onQuery(s) : setLocal(s));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const shown = (onQuery ? options : options.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(text.toLowerCase()))).filter((o) => !values.includes(o.value)).slice(0, 12);
  const full = multiple && maxItems != null && values.length >= maxItems;
  const add = (v: string) => {
    const t = v.trim();
    if (!t) return;
    const problem = validate?.(t);
    if (problem) return setError(problem);
    setError(null);
    onChange(multiple ? [...new Set([...values, t])] : [t]);
    setText('');
    setActive(0);
    setNavigated(false);
  };
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="stack" ref={box}>
      {values.length > 0 && (
        <div className="chips">
          {values.map((v) => (
            <span key={v} className="chip on" onClick={() => onChange(values.filter((x) => x !== v))} title="Remove">
              {v}
              {describe?.(v) ? <span className="muted"> · {describe(v)}</span> : null} <span className="x">✕</span>
            </span>
          ))}
        </div>
      )}
      {quick && quick.values.some((v) => !values.includes(v)) && (
        <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(multiple ? [...new Set([...values, ...quick.values])].slice(0, maxItems ?? Infinity) : [quick.values[0]])}>
          + {quick.label}
        </button>
      )}
      {!full && (
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={text}
            placeholder={placeholder}
            style={{ width: '100%' }}
            onFocus={() => setOpen(true)}
            onChange={(e) => (setText(e.target.value), setOpen(true), setActive(0), setNavigated(false), setError(null))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setNavigated(true);
                setOpen(true);
                setActive((a) => Math.min(a + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setNavigated(true);
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'Enter') {
                e.preventDefault();
                const typed = text.trim();
                const exact = shown.find((o) => o.value.toLowerCase() === typed.toLowerCase());
                const highlighted = open ? shown[active] : undefined;
                // Enter adds what you typed, unless you moved to a suggestion, or what you typed
                // isn't valid on its own (words in a NAICS box) and there is a suggestion to take.
                if (exact) add(exact.value);
                else if (highlighted && (navigated || (validate && validate(typed)))) add(highlighted.value);
                else add(typed);
              }
            }}
          />
          {open && (loading || (text.trim() && !shown.length)) && (
            <div className="suggest-pop">
              <span className="small muted" style={{ padding: '5px 8px' }}>
                {loading ? 'Searching…' : (emptyHint ?? 'No suggestions. Press Enter to add what you typed.')}
              </span>
            </div>
          )}
          {open && !loading && shown.length > 0 && (
            <div className="suggest-pop" role="listbox">
              {shown.map((o, i) => (
                <button type="button" role="option" aria-selected={i === active} key={o.value} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => (e.preventDefault(), add(o.value))}>
                  <span className="mono">{o.value}</span> <span>{o.label}</span>
                  {o.hint && <span className="muted small"> · {o.hint}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <span className="small" style={{ color: 'var(--bad)' }}>{error}</span>}
      {full && <span className="small muted">This tool accepts at most {maxItems}.</span>}
    </div>
  );
}

function NaicsPicker({ field, values, onChange }: { field: Field; values: unknown[]; onChange: (v: unknown[]) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const search = useQuery({ queryKey: ['ref-naics', dq], queryFn: () => api.get<{ options: any[] }>(`/api/reference/naics?q=${encodeURIComponent(dq)}`), staleTime: 300_000 });
  const profile = useQuery({ queryKey: ['ref-naics', ''], queryFn: () => api.get<{ options: any[] }>('/api/reference/naics?q='), staleTime: 300_000 });
  const titles = useMemo(() => new Map([...(profile.data?.options ?? []), ...(search.data?.options ?? [])].map((o: any) => [o.code, o.title ?? o.sector])), [profile.data, search.data]);
  const mine = (profile.data?.options ?? []).filter((o: any) => o.inProfile).map((o: any) => o.code);
  const options: Option[] = (search.data?.options ?? []).map((o: any) => ({
    value: o.code,
    label: o.title ?? (o.sector ? `${o.sector} sector` : 'No title on file'),
    hint: [o.inProfile && 'your profile', o.count && `${o.count} in GovCheck`].filter(Boolean).join(' · ') || undefined,
  }));
  return (
    <SuggestList
      values={values.map(String)}
      onChange={(vals) => onChange(vals.map((v) => coerce(v, field.valueType)))}
      options={options}
      multiple={field.multiple}
      maxItems={field.maxItems}
      query={q}
      onQuery={setQ}
      placeholder="Type a code (5415…) or words (computer, engineering)"
      validate={(t) => (NAICS_CODE.test(t) ? null : 'Pick a suggestion, or type a 2–6 digit NAICS code.')}
      quick={mine.length ? { label: `Add my profile's NAICS (${mine.length})`, values: mine } : undefined}
      describe={(v) => titles.get(v) ?? undefined}
      loading={dq !== q || search.isFetching}
      emptyHint="No NAICS codes match. Type the 2–6 digit code and press Enter."
    />
  );
}

function AgencyPicker({ field, values, onChange }: { field: Field; values: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const search = useQuery({ queryKey: ['ref-agencies', dq], queryFn: () => api.get<{ options: any[] }>(`/api/reference/agencies?q=${encodeURIComponent(dq)}`), staleTime: 300_000 });
  const all = useQuery({ queryKey: ['ref-agencies', ''], queryFn: () => api.get<{ options: any[] }>('/api/reference/agencies?q='), staleTime: 300_000 });
  const preferred = (all.data?.options ?? []).filter((o: any) => o.preferred).map((o: any) => o.name);
  const options: Option[] = (search.data?.options ?? []).map((o: any) => ({
    value: o.name,
    label: o.parent ? `· ${o.parent}` : '',
    hint: [o.preferred && 'preferred', o.count && `${o.count} opportunities`].filter(Boolean).join(' · ') || undefined,
  }));
  return (
    <SuggestList
      values={values}
      onChange={onChange}
      options={options}
      multiple={field.multiple}
      maxItems={field.maxItems}
      query={q}
      onQuery={setQ}
      placeholder="Start typing an agency name"
      quick={preferred.length ? { label: `Add my preferred agencies (${preferred.length})`, values: preferred } : undefined}
      loading={dq !== q || search.isFetching}
      emptyHint="No agencies in GovCheck match. Press Enter to use the name you typed."
    />
  );
}
