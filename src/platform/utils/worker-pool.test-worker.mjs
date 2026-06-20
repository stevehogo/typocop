// Synthetic worker fixture for worker-pool.test.ts (B1).
//
// Plain ESM JS so worker_threads loads it natively under vitest (a .ts entry
// cannot be loaded without a TS loader). It speaks the generic pool protocol:
// receive { kind: "task", task: { index, ...directives } } and reply
// { kind: "result", result: { index, value } }.
//
// Directives let a test drive every resilience path deterministically:
//   delayMs  — sleep before replying (order-independence under skew).
//   crash    — exit the worker process mid-task (segfault-style; pool respawns).
//   hang     — never reply (exercises the per-task timeout watchdog).
import { parentPort } from "node:worker_threads";

parentPort.on("message", (msg) => {
  if (msg?.kind !== "task") return;
  const task = msg.task;
  if (task.crash) {
    // Die without replying — the pool sees `exit` and respawns into this slot.
    process.exit(1);
    return;
  }
  if (task.hang) {
    return; // never reply → watchdog fires
  }
  const reply = () =>
    parentPort.postMessage({ kind: "result", result: { index: task.index, value: task.value } });
  if (typeof task.delayMs === "number" && task.delayMs > 0) {
    setTimeout(reply, task.delayMs);
  } else {
    reply();
  }
});
