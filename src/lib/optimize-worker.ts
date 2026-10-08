import { runOptimizeJob, type OptimizeJobInput, type OptimizeJobMessage } from "./optimize-job";

/**
 * The background worker behind "Optimize planning": the whole calculation runs
 * here, so the page never blocks. A page that cancels simply drops this worker —
 * nothing it computed is used, because the advisor only ever returns a preview.
 */
interface WorkerScope {
  onmessage: ((event: { data: OptimizeJobInput }) => void) | null;
  postMessage: (message: OptimizeJobMessage) => void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  runOptimizeJob(event.data, (message) => scope.postMessage(message));
};
