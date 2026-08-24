// What we know about a table, in sentences rather than a graph.
//
// The lineage canvas is excellent and it assumes you want to read a diagram.
// Most of the questions people bring do not need one: where did this column
// come from, what breaks if I change it, when did this last really run. This
// answers those in the detail panel, where they are asked.
//
// Everything here is derived from runs that have already happened. A table
// nobody has analysed says so — "we have not looked" is a different statement
// from "nothing feeds this", and only one of them is ever true by default.

import { refLabel, refParts } from './api'
import { answersFor, codeChangedSinceRun, type TableAnswers as Answers } from './answers'

export function TableAnswers({
  table,
  lakehouse,
}: {
  table: string
  lakehouse?: string | undefined
}) {
  const answers = answersFor({ table, lakehouse })

  if (answers.unexamined) {
    return (
      <p className="fx-answers-none">
        No sandbox run has touched this table yet, so there is nothing to say about
        where it comes from. Run the notebook that writes it and this fills in.
      </p>
    )
  }

  return (
    <div className="fx-answers">
      <LastRun answers={answers} />
      <Origins answers={answers} />
      <Consumers answers={answers} />
      <Touched answers={answers} />
      {answers.refs.length > 1 && (
        <p className="fx-answers-note">
          More than one table matched this name:{' '}
          {answers.refs.map((r) => refParts(r).workspace || 'unknown workspace').join(', ')}. The
          answers above merge them.
        </p>
      )}
    </div>
  )
}

/**
 * The last time this really ran in Fabric — not a sandbox analysis.
 *
 * First, because it is the question that decides whether anything below it is
 * worth reading. A perfect lineage for a pipeline that has not run since
 * Tuesday is a description of intentions.
 */
function LastRun({ answers }: { answers: Answers }) {
  const run = answers.lastRealRun
  if (!run) {
    return (
      <section className="fx-answers-block">
        <h3>Last real run</h3>
        <p className="fx-answers-quiet">
          Not known. Nothing has fetched this table&rsquo;s run history from Fabric — that
          needs the toolkit wired to a tenant.
        </p>
      </section>
    )
  }

  const stale = codeChangedSinceRun(run)
  const ok = run.state.toLowerCase().includes('success')

  return (
    <section className="fx-answers-block">
      <h3>Last real run</h3>
      <p>
        <span className="fx-answers-state" data-ok={ok || undefined} data-bad={!ok || undefined}>
          {run.state || 'unknown'}
        </span>{' '}
        {when(run.submittedAt)}
        {run.submitter && <> · submitted by {run.submitter}</>}
      </p>
      <p className="fx-answers-quiet">Produced by {run.via}.</p>
      {stale && (
        <p className="fx-answers-warn">
          The notebook has been edited since this ran, so it describes code that never
          executed.
        </p>
      )}
    </section>
  )
}

/** Where each column came from, one line each. */
function Origins({ answers }: { answers: Answers }) {
  if (answers.columns.length === 0) {
    return (
      <section className="fx-answers-block">
        <h3>Where the columns come from</h3>
        <p className="fx-answers-quiet">
          The run that wrote this table resolved no column-level lineage. That is usually
          a source table whose schema could not be read, or code the analyser could not
          follow — the run report says which.
        </p>
      </section>
    )
  }

  return (
    <section className="fx-answers-block">
      <h3>Where the columns come from</h3>
      <ul className="fx-answers-list">
        {answers.columns.map(({ column, sources }) => (
          <li key={column}>
            <strong>{column}</strong>
            {sources.length === 0 ? (
              <span className="fx-answers-quiet"> — no source resolved</span>
            ) : (
              <ul>
                {sources.map((s, i) => (
                  <li key={`${s.ref}${s.column}${i}`}>
                    from <code>{s.column}</code> in {s.ref ? refLabel(s.ref) : 'an unnamed table'}
                    {s.transform && (
                      <>
                        {' '}
                        <span className="fx-answers-quiet" title={s.transform}>
                          (derived)
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Who reads this — the "can I change it" question. */
function Consumers({ answers }: { answers: Answers }) {
  return (
    <section className="fx-answers-block">
      <h3>What reads this</h3>
      {answers.readBy.length > 0 && (
        <p>
          Notebooks: {answers.readBy.map((t) => t.name).join(', ')}.
        </p>
      )}
      {answers.consumers.length > 0 ? (
        <ul className="fx-answers-list">
          {answers.consumers.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong> <span className="fx-answers-quiet">{c.kind}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fx-answers-quiet">
          {answers.consumersChecked
            ? 'No reports or semantic models read this.'
            : // The distinction that stops an unconfigured tenant reading as
              // "nothing depends on this".
              'Reports and semantic models were not checked, so this does not mean nothing reads it.'}
        </p>
      )}
    </section>
  )
}

/** Who writes it, so there is somewhere to go and look. */
function Touched({ answers }: { answers: Answers }) {
  if (answers.writtenBy.length === 0) return null
  return (
    <section className="fx-answers-block">
      <h3>What writes this</h3>
      <ul className="fx-answers-list">
        {answers.writtenBy.map((t) => (
          <li key={t.name}>
            <strong>{t.name}</strong>{' '}
            <span className="fx-answers-quiet">analysed {relative(t.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** An ISO timestamp Fabric gave us, in words. */
function when(iso: string): string {
  const at = new Date(iso).getTime()
  return Number.isFinite(at) ? relative(at) : 'at an unknown time'
}

function relative(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
