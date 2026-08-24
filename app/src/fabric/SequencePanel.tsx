// The sandbox sequence — Explore's third column. Deliberately NOT a builder
// with its own picker: the tree already is the picker, and adding happens on
// the row you are looking at (`AddToSequence` in routes/fabric/explore.tsx).
// This panel owns exactly two things the tree cannot express — the ORDER of
// the steps, and Run.
//
// The lineage those steps produce is drawn by `SequenceCanvas` in the detail
// column's Sandbox tab; both read the one module store in `fabric/sequence.ts`.
import { useEffect, useRef, useState } from 'react'

import { BarsSpinner } from '../shell/BarsSpinner'
import { parseNotebook } from './notebookFile'
import { TaskSteps, type TaskStepStatus } from './TaskSteps'
import {
  useSequence,
  removeStep,
  moveStep,
  clearSteps,
  runAll,
  setCompareWithReal,
  type StepKind,
  addStep,
  hydrateSequence,
  type StepStatus,
} from './sequence'

export function StepIcon({ kind }: { kind: StepKind }) {
  return (
    <svg
      className="fx-icon"
      data-kind={kind === 'pipeline' ? 'item' : 'notebook'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      {kind === 'pipeline' ? (
        <path d="M4 5h6v5H4zM14 14h6v5h-6zM10 7.5h2.5a1.5 1.5 0 0 1 1.5 1.5v6" />
      ) : (
        <path d="M6 3h9l4 4v14H6z M15 3v4h4M9 12h6M9 16h6" />
      )}
    </svg>
  )
}

export function SequencePanel({ title = 'Sandbox sequence' }: { title?: string }) {
  const { steps, results, running, compareWithReal, restoredAt } = useSequence()
  const [adding, setAdding] = useState(false)

  // Put the last run back, once. In an effect rather than at module load so
  // importing this file never touches storage — which is what tests and any
  // future non-browser consumer rely on.
  useEffect(() => {
    hydrateSequence()
  }, [])

  return (
    <>
      <div className="fx-panel-head fx-panel-head--row">
        <span>{title}</span>
        <button className="fx-panel-clear" onClick={() => setAdding((v) => !v)} disabled={running}>
          {adding ? 'Close' : 'Add code'}
        </button>
        {steps.length > 0 && (
          <button className="fx-panel-clear" onClick={clearSteps} disabled={running}>
            Clear
          </button>
        )}
      </div>

      {adding && <AddCode onDone={() => setAdding(false)} />}

      {/* Never let an old result pass for a fresh one. The notebook may have
          changed since this ran, so the panel says when it was and leaves the
          judgement to the reader. */}
      {restoredAt !== null && (
        <p className="sbx-restored" role="status">
          Showing your last run, from {whenRun(restoredAt)}. The notebooks may have
          changed since — run again for a current answer.
        </p>
      )}

      <div className="sbx-steps">
        {steps.length === 0 ? (
          <p className="fx-empty">
            Empty. Hover a notebook or pipeline in the tree and hit its <span className="fx-kbd">▶</span>{' '}
            to stack it here, then reorder and run. Steps execute top-to-bottom.
            {' '}Or use <strong>Add code</strong> above to open a notebook file or paste
            SQL — that needs no Fabric connection at all.
          </p>
        ) : running ? (
          // A run is a progress view, not an editable list: reordering a
          // sequence that is halfway through would be meaningless, and the
          // controls are disabled anyway. This is the same rows with the
          // status made legible.
          <TaskSteps
            steps={steps.map((step) => {
              const result = results.get(step.key)
              return {
                id: step.key,
                label: step.name,
                ...(result?.ms ? { meta: elapsed(result.ms) } : {}),
              }
            })}
            statusOf={(id) => toTaskStepStatus(results.get(id)?.status)}
            label="Sandbox run progress"
          />
        ) : (
          steps.map((step, i) => {
            const result = results.get(step.key)
            const st = result?.status
            return (
              <div className="sbx-step" key={step.key} data-status={st}>
                <span className="sbx-step-num">{i + 1}</span>
                <StepIcon kind={step.kind} />
                <span className="sbx-step-name" title={step.name}>
                  {step.name}
                </span>
                {/* The timing outlives the run. It is shown during one by the
                    progress view, and losing it the moment the run ended
                    meant "how long did that take" was answerable only while
                    it was still happening. */}
                {result?.ms ? <span className="sbx-step-ms">{elapsed(result.ms)}</span> : null}
                {st === 'running' && <BarsSpinner size={14} />}
                {st === 'ok' && <span className="sbx-step-dot" data-ok />}
                {st === 'error' && <span className="sbx-step-dot" data-err />}
                <div className="sbx-step-ctrls">
                  <button onClick={() => moveStep(step.key, -1)} disabled={i === 0} aria-label="Move up">
                    ↑
                  </button>
                  <button
                    onClick={() => moveStep(step.key, 1)}
                    disabled={i === steps.length - 1}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button onClick={() => removeStep(step.key)} aria-label="Remove">
                    ×
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="sbx-run-bar">
        {/* Sits next to Run rather than in a settings menu, because it changes
            what Run costs — two extra Fabric reads per notebook — and because
            the comparison it produces is the least obvious thing the sandbox
            can tell you. A capability nobody can find is a capability nobody
            has. */}
        <label className="sbx-compare-toggle" title="Read each notebook's last real Fabric run and diff it against this one">
          <input
            type="checkbox"
            checked={compareWithReal}
            disabled={running}
            onChange={(e) => setCompareWithReal(e.target.checked)}
          />
          Compare with last real run
        </label>
        <button className="fx-btn fx-btn--primary" onClick={runAll} disabled={steps.length === 0 || running}>
          {running ? 'Running…' : `Run sequence${steps.length ? ` (${steps.length})` : ''}`}
        </button>
      </div>
    </>
  )
}

/**
 * When a restored run happened, in the terms someone judges staleness by.
 *
 * Relative for anything recent — "2 hours ago" answers "can I trust this"
 * faster than a timestamp — and an absolute date once it is old enough that
 * the exact day is the point.
 */
function whenRun(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return 'a moment ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Put code into the sandbox without going through Fabric.
 *
 * The engine only ever wanted cells, and the Explore tree was the only way to
 * supply them — so a machine with no tenant had a working engine and no way to
 * reach it. A file input and a textarea close that.
 *
 * The step is marked with the file name rather than an id: there is no Fabric
 * item behind it, and labelling it as though there were would make the run
 * report claim a notebook that does not exist.
 */
function AddCode({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [lakehouse, setLakehouse] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const reset = () => {
    setName('')
    setCode('')
    setError(null)
    onDone()
  }

  const onFile = async (file: File) => {
    setError(null)
    try {
      const parsed = parseNotebook(await file.text(), file.name)
      // Straight in: a file the user picked is an explicit act, and making
      // them press a second button to confirm their own choice is friction.
      addStep({
        kind: 'notebook',
        ws: 'local',
        itemId: `file:${file.name}`,
        name: parsed.name,
        cells: parsed.cells,
        lakehouse,
      })
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const addPasted = () => {
    const trimmed = code.trim()
    if (!trimmed) {
      setError('Nothing to run — paste some SQL or PySpark first.')
      return
    }
    addStep({
      kind: 'notebook',
      ws: 'local',
      itemId: `pasted:${Date.now()}`,
      name: name.trim() || 'pasted code',
      cells: [trimmed],
      lakehouse,
    })
    reset()
  }

  return (
    <div className="sbx-add">
      <div className="sbx-add-row">
        <input
          value={name}
          placeholder="Name (optional)"
          aria-label="Step name"
          onChange={(e) => setName(e.target.value)}
        />
        <input
          value={lakehouse}
          placeholder="Lakehouse"
          aria-label="Default lakehouse"
          title="What an unqualified table name resolves against, as in Fabric"
          onChange={(e) => setLakehouse(e.target.value)}
        />
      </div>
      <textarea
        value={code}
        spellCheck={false}
        aria-label="Code to analyse"
        placeholder={'spark.sql("CREATE TABLE lh_silver.customers AS SELECT id FROM lh_bronze.raw")'}
        onChange={(e) => setCode(e.target.value)}
      />
      {error && <p className="sbx-add-error">{error}</p>}
      <div className="sbx-add-row">
        <button onClick={addPasted}>Add</button>
        <button onClick={() => fileInput.current?.click()}>Open .ipynb…</button>
        <button onClick={reset}>Cancel</button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".ipynb,.py,.sql,.txt"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so picking the same file twice fires again.
          e.target.value = ''
          if (file) void onFile(file)
        }}
      />
    </div>
  )
}

/**
 * A step's real `StepStatus` (sequence.ts) → what `TaskSteps` draws.
 *
 * Per step, not inferred from how far the run has gotten — `runAll` keeps
 * going after a step errors, so a middle step's failure has to say so on its
 * own row rather than being overtaken by whatever ran after it. `skipped`
 * reads as `pending`: nothing happened there to report as done or failed.
 */
function toTaskStepStatus(status: StepStatus | undefined): TaskStepStatus {
  switch (status) {
    case 'running':
      return 'active'
    case 'ok':
      return 'done'
    case 'error':
      return 'error'
    default:
      return 'pending'
  }
}

/** A duration in the units a reader compares at a glance. */
function elapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
