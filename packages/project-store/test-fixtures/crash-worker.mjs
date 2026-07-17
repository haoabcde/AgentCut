import { readFileSync } from "node:fs";
import { ProjectStore } from "../dist/index.js";

const [databasePath, transactionPath, failurePoint] = process.argv.slice(2);
if (!databasePath || !transactionPath || !failurePoint) {
  throw new Error("Usage: crash-worker.mjs DATABASE TRANSACTION FAILURE_POINT");
}

const transaction = JSON.parse(readFileSync(transactionPath, "utf8"));
const store = ProjectStore.open(databasePath, {
  checkpointInterval: 1,
  failureInjector(point) {
    if (point !== failurePoint) return;
    if (process.platform === "win32") process.abort();
    process.kill(process.pid, "SIGKILL");
  },
});

store.commit(transaction);
store.close();
