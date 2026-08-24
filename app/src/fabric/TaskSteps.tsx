// A checklist that shows a run happening: pending, active, done, failed.
//
// Ported from a shadcn/Tailwind/motion snippet into this repo's idiom, the
// same way `shell/BarsSpinner` was — no "use client" (Vite, not Next), no `@`
// alias, no utility classes, and the animation lives in CSS rather than in a
// JS animation runtime.
//
// WHY NO `motion`. The original uses springs for the tick pop, a rotating arc,
// and a gradient sweep across the active label. All three are keyframes, and
// keyframes are what CSS is for — adding an animation runtime to the bundle to
// spin a circle would be the largest dependency in this app after React, for
// four effects that are twenty lines of `@keyframes`. The visual result is the
// same and the reduced-motion handling is better: `prefers-reduced-motion` is
// honoured by the stylesheet, so it applies even before this component's
// JavaScript has run.
//
// `useTaskSteps` is kept exactly as the original defines it — the status
// derivation and the spoken sentence are the useful part, and they are pure.

import { useEffect, useState } from 'react'

export interface TaskStep {
  id: string
  label: string
  /** Shown once the step is done — an elapsed time, typically. */
  meta?: string | undefined
}

export type TaskStepStatus = 'pending' | 'active' | 'done' | 'error'

export interface UseTaskStepsOptions {
  steps: TaskStep[]
  /**
   * Each step's REAL status — not derived from "how far in" the run is.
   *
   * Earlier this took `current` (an index) plus one `failed` boolean for the
   * whole run, on the assumption that a run stops at its first failure. It
   * doesn't: `sequence.ts`'s `runAll` keeps going after a step errors, so a
   * step that failed in the middle of a run — with a later step still
   * completing after it — had no way to report as failed. The index had
   * already moved past it, and "done" was the only label left to fall into.
   * A caller with several independent steps (not a strict pipeline) needs
   * exactly that shape to render honestly, so status now comes from the
   * caller per step instead of being inferred.
   */
  statusOf: (id: string) => TaskStepStatus
}

export function useTaskSteps({ steps, statusOf }: UseTaskStepsOptions) {
  const rows = steps.map((step) => ({ ...step, status: statusOf(step.id) }))

  const failedRow = rows.find((r) => r.status === 'error')
  const active = rows.find((r) => r.status === 'active')
  const complete = rows.length > 0 && rows.every((r) => r.status === 'done')
  const failed = Boolean(failedRow)

  const sentence = failedRow
    ? `Failed at ${failedRow.label}`
    : complete
      ? `All ${steps.length} steps complete`
      : active
        ? `${active.label}, step ${rows.indexOf(active) + 1} of ${steps.length}`
        : ''

  return { rows, complete, failed, sentence }
}

const Tick = (
  <svg viewBox="0 0 256 256" width="11" height="11" fill="none" aria-hidden>
    <polyline
      points="216 72 104 184 48 128"
      stroke="currentColor"
      strokeWidth="26"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const Cross = (
  <svg viewBox="0 0 256 256" width="10" height="10" fill="none" aria-hidden>
    <path d="M200 56 56 200 M56 56l144 144" stroke="currentColor" strokeWidth="26" strokeLinecap="round" />
  </svg>
)

/** The spinning arc. Rotation is a CSS animation on the svg itself. */
const Arc = (
  <svg viewBox="0 0 16 16" className="ts-arc" aria-hidden>
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

export interface TaskStepsProps extends UseTaskStepsOptions {
  label?: string
  className?: string
}

export function TaskSteps({
  steps,
  statusOf,
  label = 'Task progress',
  className = '',
}: TaskStepsProps) {
  const { rows, complete, failed, sentence } = useTaskSteps({ steps, statusOf })

  // The announcement is delayed so a fast sequence does not queue a sentence
  // per step and read them all out after the run has finished.
  const [spoken, setSpoken] = useState('')
  useEffect(() => {
    if (!sentence) return
    const timer = setTimeout(() => setSpoken(sentence), 500)
    return () => clearTimeout(timer)
  }, [sentence])

  return (
    <div className={`ts ${className}`}>
      <ol aria-label={label} className="ts-list">
        {rows.map((row) => (
          <li
            key={row.id}
            className="ts-row"
            data-status={row.status}
            aria-current={row.status === 'active' ? 'step' : undefined}
          >
            <span className="ts-mark">
              {row.status === 'done'
                ? Tick
                : row.status === 'error'
                  ? Cross
                  : row.status === 'active'
                    ? Arc
                    : null}
            </span>

            <span className="ts-label">{row.label}</span>

            {/* Held in the layout at all times and revealed when the step
                finishes: appearing from nothing would shift the row's width
                the instant it completes. */}
            {row.meta ? (
              <span className="ts-meta" aria-hidden={row.status !== 'done'}>
                {row.meta}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {/* Two regions, not one. The step-by-step commentary is polite chatter;
          the terminal state is the thing a screen-reader user is waiting for,
          so it is announced separately and only when it happens. */}
      <span role="status" className="ts-sr">
        {spoken}
      </span>
      <span className="ts-sr" aria-live={complete || failed ? 'polite' : 'off'}>
        {complete ? 'Run complete' : failed ? 'Run failed' : ''}
      </span>
    </div>
  )
}

export default TaskSteps
