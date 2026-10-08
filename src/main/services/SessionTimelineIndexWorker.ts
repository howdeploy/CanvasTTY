import { parentPort, workerData } from "node:worker_threads";
import { scanTimelineDirectory } from "./TimelineIndexScan.ts";

if (!parentPort || typeof workerData?.directory !== "string") throw new Error("Session timeline index worker requires its journal directory.");
void scanTimelineDirectory(workerData.directory).then(
  value => parentPort!.postMessage(value),
  error => parentPort!.postMessage({ error: error instanceof Error ? error.message : "Timeline scan failed." })
);
