import { Worker } from "node:worker_threads";
import { Router } from "express";
import { HttpError, validate } from "../../lib/http.js";
import { requireRole } from "../auth/auth.routes.js";
import { demoInput } from "./manager.js";
import { simulationTarget } from "./scope.js";

export function simulationWorker(uri) {
  if (!simulationTarget(uri, process.env)) return null;
  let worker,
    sequence = 0,
    closed = false;
  const pending = new Map();
  function unavailable() {
    return new HttpError(
      503,
      "SIMULATION_UNAVAILABLE",
      "Simulation storage is temporarily unavailable. Try again shortly.",
    );
  }
  function boot() {
    if (closed || worker) return;
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: { uri },
      env: {},
    });
    worker.on("message", ({ id, error, result }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (error)
        p.reject(new HttpError(error.status, error.code, error.message));
      else p.resolve(result);
    });
    worker.on("error", () => {});
    worker.once("exit", () => {
      worker = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(unavailable());
      }
      pending.clear();
    });
  }
  boot();
  const restart = setInterval(boot, 60000).unref();
  function call(method, arg) {
    if (closed || pending.size >= 32) return Promise.reject(unavailable());
    boot();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const deadline = performance.now() + 30000;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(unavailable());
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, method, arg, deadline });
    });
  }
  return {
    call,
    close() {
      closed = true;
      clearInterval(restart);
      if (!worker) return Promise.resolve();
      const current = worker;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => current.terminate(), 10000).unref();
        current.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        current.postMessage({ method: "close" });
      });
    },
  };
}
export function simulationRoutes(service, auth) {
  const router = Router(),
    base = "/operations/simulation";
  const call = (...args) => {
    if (!service)
      throw new HttpError(
        503,
        "SIMULATION_UNAVAILABLE",
        "Simulation requires a disposable local proof database or the hosted demo service.",
      );
    return service.call(...args);
  };
  const admin = [
    async (req, _res, next) => {
      // The control plane shares the simulation budget, including its account reads.
      req.user = await auth.authenticate(
        req.get("Authorization"),
        service ? (id) => call("accountRole", id) : undefined,
      );
      next();
    },
    requireRole("admin"),
  ];
  router.get(base, ...admin, async (_req, res) =>
    res.json({ run: await call("status") }),
  );
  router.post(base, ...admin, async (req, res) =>
    res.status(202).json(await call("start", validate(demoInput, req.body))),
  );
  router.delete(base + "/:runId", ...admin, async (req, res) =>
    res.json(await call("cancel", req.params.runId)),
  );
  return router;
}
