import { parentPort, workerData, isMainThread } from "node:worker_threads";
import mongoose from "mongoose";
import { createRunManager, simulationModels } from "./manager.js";

// Command monitoring fires before the driver's socket write. Waiting here only parks the simulation worker.
export function commandPacer(spacingMs = 22) {
  if (isMainThread) throw Error("Command pacing requires a dedicated worker.");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let previous = -Infinity,
    window = [],
    peak = 0,
    count = 0;
  return {
    before() {
      let now = performance.now();
      while (now - previous < spacingMs) {
        Atomics.wait(wait, 0, 0, spacingMs - (now - previous));
        now = performance.now();
      }
      previous = now;
      window = window.filter((t) => now - t < 1000);
      window.push(now);
      count++;
      peak = Math.max(peak, window.length);
    },
    reset() {
      window = [];
      peak = 0;
      count = 0;
    },
    measure: () => ({ commands: count, peakPerSecond: peak, spacingMs }),
  };
}
async function serve() {
  const pacer = commandPacer();
  const client = new mongoose.mongo.MongoClient(workerData.uri, {
    monitorCommands: true,
    maxPoolSize: 3,
    serverSelectionTimeoutMS: 6000,
    timeoutMS: 10000,
    socketTimeoutMS: 10000,
  });
  client.on("commandStarted", pacer.before);
  client.on("serverHeartbeatStarted", pacer.before);
  await client.connect();
  const connection = mongoose.createConnection().setClient(client);
  const models = await simulationModels(connection);
  const manager = createRunManager({
    models,
    connection,
    beginMeasure: pacer.reset,
    measure: pacer.measure,
  });
  await manager.maintenance();
  let maintaining = false;
  const timer = setInterval(async () => {
    if (maintaining) return;
    maintaining = true;
    try {
      await manager.maintenance();
    } catch {
      /* The next tick retries incomplete recovery. */
    } finally {
      maintaining = false;
    }
  }, 60000);
  parentPort.on("message", async ({ id, method, arg, deadline }) => {
    try {
      let result;
      if (method === "close") {
        clearInterval(timer);
        await manager.shutdown();
        await connection.close();
        parentPort.close();
        return;
      }
      if (performance.now() >= deadline)
        throw Error("Simulation request expired.");
      if (method === "accountRole") {
        result = await connection
          .collection("users")
          .findOne(
            { _id: new mongoose.Types.ObjectId(arg) },
            { projection: { _id: 0, role: 1, isGuest: 1 } },
          );
      } else if (method === "start") {
        result = await manager.start(arg);
      } else if (method === "cancel") result = await manager.cancel(arg);
      else result = await manager.status();
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({
        id,
        error: error.status
          ? { status: error.status, code: error.code, message: error.message }
          : {
              status: 503,
              code: "SIMULATION_UNAVAILABLE",
              message: "Simulation storage is temporarily unavailable.",
            },
      });
    }
  });
}
if (!isMainThread) serve().catch(() => process.exit(1));
