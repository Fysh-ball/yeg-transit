#!/usr/bin/env node
/**
 * COPY of prometheus scripts/upstream-alert.ts (2026-10-30), imports pointed at release/current, because the
 * release ships no scripts/ (Lumi Main). Used by nas-watch and dnsguard. Drop it once alert-spool/bin ships one.
 *
 * One line onto the alert path, for a caller that is a shell script and has no session.
 *
 * `scripts/upstream-rollback.sh` needs to say "upstream <tag> failed gate <g>, restored <tag>"
 * somewhere a human reads. The custodian's brief composes from a SWEEP's findings and cannot be
 * appended to from outside, and `custodian/findings.jsonl` is an AUTHORITY INPUT to the responder
 * unit -- a shell script minting rows there would be manufacturing the evidence containment acts
 * run on. So this writes to the alert spool instead, the same writer `custodian/src/notify.ts`,
 * `deadman/bin/sweep.ts` and `responder/src/respond.ts` use, under its own condition.
 *
 *   node scripts/upstream-alert.ts --spool <root> --condition upstream-rollback \
 *        --result ok|failed|partial --body '<one line>'
 *
 * TWO MESSAGES PER EVENT, NEVER COLLAPSED, and the first draft of this file got it wrong. The
 * channel's contract (docs/prometheus/INVENTORY.md, the alert-spool section) is intent before the
 * act and outcome after, paired by `corr`, because AN INTENT WITH NO OUTCOME IS ITSELF THE ALARM:
 * the handset raises a lone intent client-side as a lost event. A rollback that spooled one intent
 * and stopped would therefore fire the loss alarm on every single rollback, and the one signal that
 * is supposed to mean "this box died mid-alert" would come to mean "upstream tracking ran".
 * `responder/src/respond.ts` makes the same repair for an outcome with no intent to cite. So both
 * rows are written here, and `--result` is REQUIRED rather than defaulted: a rollback that failed
 * to restore and one that succeeded must not spool the same grade, and there is no safe guess.
 *
 * RUN DIRECTLY BY NODE FROM THE DEPLOY TREE, with no node_modules, which is why the import below
 * is a RELATIVE path into the sibling package and not `@prometheus/alert-spool` (the rule the
 * custodian and responder host units already follow). MEASURED 2026-09-06 on node v26.8.1: a bare
 * `.ts` entry point with a relative `.ts` import and a type annotation loads and runs. The node on
 * Apollo is NOT measured here; custodian's host unit running `bin/sweep.ts` under bare node is
 * precedent for it, not proof.
 *
 * TYPECHECKED ON COMMIT LIKE A PACKAGE, since 2026-09-07: `scripts/tsconfig.json` includes this
 * file and pre-commit's `check-typecheck.sh` compiles it whenever a top-level `scripts/*.ts`, that
 * tsconfig or `tsconfig.base.json` is staged. Before that no tsconfig reached `scripts/`, and the
 * hand-run `tsc` command written here was the only check; the gate replaced it.
 *
 * Exit: 0 both rows were appended; 1 the spool refused a row or could not be opened; 2 the
 * arguments could not be read. 1 and 2 are kept apart because "nobody was told" and "you asked
 * for something I could not parse" send a reader to different places.
 */
import { parseArgs } from 'node:util'
import { openSpool } from '/mnt/Playground/prometheus-hands/release/current/packages/alert-spool/src/index.ts'
import type { AlertResult } from '/mnt/Playground/prometheus-hands/release/current/packages/alert-spool/src/index.ts'

const USAGE =
  'usage: upstream-alert.ts --spool <root> --condition <name> --result ok|failed|partial --body <text>'

function refuse(why: string): never {
  process.stderr.write(`ALERT REFUSED: ${why}\n${USAGE}\n`)
  process.exit(2)
}

let parsed: { spool?: string, condition?: string, result?: string, body?: string }
try {
  // `strict: true`: an unknown flag is a refusal, never a default. An alert emitter that silently
  // ignored `--conditon` would spool the row under the wrong condition and the reader would filter
  // it away. AN UNKNOWN FLAG MUST NOT MEAN "RUN EVERYTHING", which is the same rule
  // `scripts/check-upstream-clean.sh` and `scripts/run-harnesses.py` state for themselves.
  const { values } = parseArgs({
    options: {
      spool: { type: 'string' },
      condition: { type: 'string' },
      result: { type: 'string' },
      body: { type: 'string' },
    },
    strict: true,
  })
  parsed = values
} catch (error) {
  // The message is PRESERVED, never swallowed: parseArgs names the offending option and that name
  // is the only thing that tells the caller which flag it typed wrong.
  refuse(error instanceof Error ? error.message : String(error))
}

const spool = parsed.spool
const condition = parsed.condition
const body = parsed.body
const result = parsed.result
if (spool === undefined || condition === undefined || body === undefined || result === undefined) {
  refuse('--spool, --condition, --result and --body are all required.')
}
if (result !== 'ok' && result !== 'failed' && result !== 'partial') {
  refuse(`--result ${result} is not one of ok|failed|partial.`)
}
const grade: AlertResult = result

/**
 * A SPOOL HELD BY A LIVE WRITER IS NOT A DEAD SPOOL. `alert-spool/src/lock.ts` refuses a second
 * live writer on purpose, and the deadman sweep's minute timer and custodian's hourly one both
 * hold it briefly. Without the wait a rollback landing on that second reports "nobody was told"
 * over a spool that was working. Same tries and gap as `custodian/src/notify.ts`'s
 * `openSpoolWaiting`, which exists for the same overlap; only `writer-live` is retried, because
 * every other failure kind is not going to change by waiting. The numbers are COPIED, not
 * measured for a 03:00 rollback: WORK-BREAKDOWN U13.6.3 records that.
 */
const SPOOL_OPEN_TRIES = 5
const SPOOL_RETRY_MS = 400
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => { setTimeout(resolve, ms) })

let opened = openSpool(spool)
for (let attempt = 1; attempt < SPOOL_OPEN_TRIES && !opened.ok && opened.failure.kind === 'writer-live'; attempt += 1) {
  await sleep(SPOOL_RETRY_MS)
  opened = openSpool(spool)
}
if (!opened.ok) {
  process.stderr.write(`ALERT NOT SPOOLED: ${spool}: ${opened.failure.kind}: ${opened.failure.why}\n`)
  process.exit(1)
}
const writer = opened.writer
try {
  const intent = writer.intent(condition, body)
  if (!intent.ok) {
    process.stderr.write(`ALERT NOT SPOOLED: the spool refused the intent: ${intent.why}\n`)
    process.exit(1)
  }
  // THE PAIR IS CLOSED HERE OR THE ROW IS A LOSS ALARM. An intent that lands and an outcome that
  // does not is exactly the handset's "something died mid-alert" shape, so a failed outcome is
  // reported as a failure of this emitter even though the intent is on disk: the reader will be
  // told something is wrong either way, and this side must not call that a delivery.
  const closed = writer.outcome(intent.id, condition, body, grade)
  if (!closed.ok) {
    process.stderr.write(
      `ALERT INCOMPLETE: intent ${intent.seq} spooled but its outcome did not land: ${closed.why}\n`,
    )
    process.exit(1)
  }
  const dropNote = intent.dropped > 0 ? ` (${intent.dropped} bytes of the body were truncated)` : ''
  process.stdout.write(`OK  spooled ${condition} ${writer.epoch}/${intent.seq} as ${grade}${dropNote}\n`)
} finally {
  writer.close()
}
