/**
 * Runs tasks one at a time, in the order they arrive: each action reads files, checks their versions, then
 * writes, so two must never interleave. A failed task does not block the ones after it.
 */
export function actionQueue() {
  let last: Promise<unknown> = Promise.resolve()
  return <R>(task: () => Promise<R>): Promise<R> => {
    const next = last.then(task)
    last = next.catch(() => undefined)
    return next
  }
}
