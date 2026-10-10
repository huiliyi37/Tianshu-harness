/** Runtime/UI address; logical workOrderId remains the dependency and resume key. */
export function workerDispatchKey(worker: { workOrderId: string; dispatchId?: string }): string {
  return worker.dispatchId ?? worker.workOrderId
}
