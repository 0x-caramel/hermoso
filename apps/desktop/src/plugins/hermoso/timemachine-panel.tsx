/**
 * The Time Machine, as the person uses it: Hermes snapshots the project folder just before the agent first changes a
 * file in a turn; here the snapshots of the open chat are listed, each can show what changed since, and the project
 * (and the chat) can be put back to how they were. The snapshots and the rewinding are Hermes' own (the gateway's
 * `rollback.*`); this only asks and paints.
 */

import { Button, cn, host, ToggleRow, useValue } from '@hermes/plugin-sdk'
import { IconHistory } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'

import type { RestoreResult, SnapshotDiff, SnapshotList } from './api'
import { $timeMachine, diffSnapshot, listSnapshots, noteRewind, restoreSnapshot, setTimeMachineOn } from './store'
import { STRINGS } from './strings'

const T = STRINGS.timeMachine

const CAPTION = 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)'

/** The most snapshots listed: Hermes keeps twenty per folder. */
const LISTED = 10

/** A diff longer than this is cut: the panel is not a pager. */
const DIFF_LIMIT = 2_400

export function whenText(timestamp: string): string {
  const at = new Date(timestamp)

  return Number.isNaN(at.getTime()) ? timestamp : at.toLocaleString()
}

export function summaryOf(result: RestoreResult): string {
  const restored = result.restored_files?.length ?? 0
  const kept = result.skipped_user_edits?.length ?? 0
  const stuck = result.failed_deletes?.length ?? 0

  return [T.rewound(restored), kept > 0 ? T.keptEdits(kept) : '', stuck > 0 ? T.stuck(stuck) : '', T.chatLeft]
    .filter(Boolean)
    .join(' ')
}

export function TimeMachinePanel({ className }: { className?: string }) {
  const state = useValue($timeMachine)
  const sessionId = useValue(host.state.activeSessionId)
  const working = useValue(host.state.busy)

  // undefined: looking; null: Hermes did not answer
  const [list, setList] = useState<null | SnapshotList | undefined>(undefined)
  const [diffs, setDiffs] = useState<Record<string, 'loading' | SnapshotDiff | null>>({})
  const [confirming, setConfirming] = useState<null | string>(null)
  const [busyHash, setBusyHash] = useState<null | string>(null)
  const [note, setNote] = useState<null | { bad: boolean; text: string }>(null)

  const refresh = useCallback(async () => {
    if (!sessionId || !state.active) {
      setList(undefined)

      return
    }

    setList(await listSnapshots(sessionId))
  }, [sessionId, state.active])

  // Again whenever the chat changes, and when a turn starts or ends (a snapshot is taken in the middle of one).
  useEffect(() => {
    void refresh()
  }, [refresh, working])

  const seeChanges = async (hash: string) => {
    if (!sessionId || diffs[hash]) {
      return
    }

    setDiffs(current => ({ ...current, [hash]: 'loading' }))

    const diff = await diffSnapshot(sessionId, hash)

    setDiffs(current => ({ ...current, [hash]: diff }))
  }

  const rewind = async (hash: string) => {
    if (!sessionId) {
      return
    }

    setBusyHash(hash)
    setConfirming(null)
    setNote(null)

    const result = await restoreSnapshot(sessionId, hash)

    setBusyHash(null)

    if (result.success === true) {
      setNote({ bad: false, text: summaryOf(result) })
      setDiffs({})
      void noteRewind()
    } else {
      setNote({ bad: true, text: result.error ? T.failed(result.error) : T.failedPlain })
    }

    void refresh()
  }

  const snapshots = list?.checkpoints.slice(0, LISTED) ?? []

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2">
        <IconHistory className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="text-sm font-medium">{T.title}</span>
      </div>

      <p className={CAPTION}>{T.blurb}</p>

      <ToggleRow
        checked={state.enabled}
        description={T.switchDescription}
        label={T.switchTitle}
        onChange={on => void setTimeMachineOn(on)}
      />
      {state.enabled !== state.active && (
        <p className={CAPTION} data-testid="timemachine-restart">
          {T.restartNote}
        </p>
      )}

      {state.active && !sessionId && <p className={CAPTION}>{T.openAChat}</p>}

      {state.active && sessionId && list === undefined && <p className={CAPTION}>{T.looking}</p>}
      {state.active && sessionId && list === null && (
        <p className="text-[0.6875rem] text-destructive" role="alert">
          {T.noAnswer}
        </p>
      )}
      {state.active && sessionId && list && !list.enabled && <p className={CAPTION}>{T.notOnForThisChat}</p>}
      {state.active && sessionId && list?.enabled && snapshots.length === 0 && (
        <p className={CAPTION} data-testid="timemachine-empty">
          {T.nothingYet}
        </p>
      )}

      {snapshots.length > 0 && (
        <ul className="flex flex-col gap-3" data-testid="timemachine-list">
          {snapshots.map(snapshot => {
            const diff = diffs[snapshot.hash]

            return (
              <li className="flex flex-col gap-1.5" data-hash={snapshot.hash} key={snapshot.hash}>
                <div className="flex flex-col">
                  <span className="text-xs font-medium">{whenText(snapshot.timestamp)}</span>
                  {snapshot.message && <span className={cn(CAPTION, 'truncate')}>{snapshot.message}</span>}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    disabled={diff === 'loading'}
                    onClick={() => void seeChanges(snapshot.hash)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {T.seeChanges}
                  </Button>
                  <Button
                    disabled={busyHash !== null || working}
                    onClick={() => setConfirming(snapshot.hash)}
                    size="xs"
                    type="button"
                    variant="secondary"
                  >
                    {busyHash === snapshot.hash ? T.rewinding : T.rewindHere}
                  </Button>
                </div>

                {confirming === snapshot.hash && (
                  <div
                    className="flex flex-col gap-1.5 rounded-md bg-(--ui-bg-tertiary) p-2"
                    data-testid="timemachine-confirm"
                  >
                    <p className="text-xs">{T.confirm(whenText(snapshot.timestamp))}</p>
                    <div className="flex gap-1">
                      <Button onClick={() => void rewind(snapshot.hash)} size="xs" type="button">
                        {T.rewind}
                      </Button>
                      <Button onClick={() => setConfirming(null)} size="xs" type="button" variant="ghost">
                        {T.cancel}
                      </Button>
                    </div>
                  </div>
                )}

                {diff === 'loading' && <p className={CAPTION}>{T.looking}</p>}
                {diff === null && <p className={CAPTION}>{T.noDiff}</p>}
                {diff && diff !== 'loading' && (
                  <pre
                    className="max-h-48 overflow-auto rounded-md bg-(--ui-bg-quaternary) p-2 font-mono text-[0.6875rem] break-all whitespace-pre-wrap"
                    data-testid="timemachine-diff"
                  >
                    {[diff.stat, diff.diff].filter(Boolean).join('\n\n').slice(0, DIFF_LIMIT) || T.noChanges}
                  </pre>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {note && (
        <p
          className={cn('text-[0.6875rem]', note.bad ? 'text-destructive' : 'text-(--ui-text-secondary)')}
          data-testid="timemachine-note"
          role={note.bad ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}

      <p className={CAPTION}>{T.limits}</p>
    </div>
  )
}
