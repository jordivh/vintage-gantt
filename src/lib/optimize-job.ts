import { optimizeProject, type OptimizeInput, type OptimizeProgress, type OptimizeResult } from "./resource-optimizer";

/**
 * One optimization job, in the shape it can be posted to a worker: everything the
 * optimizer needs except the progress callback, which the worker supplies itself.
 * Everything in it is plain data, so it survives `postMessage` unchanged.
 */
export type OptimizeJobInput = Omit<OptimizeInput, "onProgress">;

/** What a running job reports back to the page. */
export type OptimizeJobMessage =
  | { type: "progress"; progress: OptimizeProgress }
  | { type: "result"; result: OptimizeResult }
  | { type: "failed"; error: string };

/**
 * Runs one job and reports progress and the result. Pure: it writes nothing, so a
 * cancelled run can never leave anything behind — "Cancel" is only the page
 * dropping the worker and its messages.
 */
export function runOptimizeJob(input: OptimizeJobInput, post: (message: OptimizeJobMessage) => void): OptimizeResult {
  try {
    const result = optimizeProject({
      ...input,
      onProgress: (progress) => post({ type: "progress", progress }),
    });
    post({ type: "result", result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "failed", error: message });
    return { ok: false, error: message };
  }
}
