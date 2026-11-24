import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { z } from "zod";
import { validate, HttpError } from "../../lib/http.js";
import { bookingSchemas } from "../booking/models.js";
import { eventSchema } from "../events/event.model.js";
import { userSchema } from "../auth/user.model.js";
import { seatSchema } from "../events/seat.model.js";
import { queueEntrySchema } from "../queue/model.js";
import { cleanFixture, runService } from "./service.js";

const day = 86400000,
  lease = 90000,
  active = ["running", "cancelling", "recovering"];
const cancelled = "admin cancellation";
export const demoInput = z.strictObject({
  users: z.number().int().min(1).max(300),
  seats: z.number().int().min(1).max(2000),
});
export async function simulationModels(connection) {
  const models = {};
  for (const [key, schema] of Object.entries({
    User: userSchema,
    Event: eventSchema,
    Seat: seatSchema,
    QueueEntry: queueEntrySchema,
    ...bookingSchemas,
  })) {
    models[key] = connection.model(
      "Simulation" + key,
      schema,
      "qt_sim_" + key.toLowerCase(),
    );
    await models[key].init();
  }
  return models;
}
export function createRunManager({
  connection,
  models,
  beginMeasure = () => {},
  measure = () => null,
  execute = runService,
}) {
  if (
    !Object.values(models).length ||
    !Object.values(models).every((m) => m.collection.name.startsWith("qt_sim_"))
  )
    throw Error("Dedicated simulation collections are required.");
  const control = connection.collection("qt_sim_control");
  let work,
    controller,
    localRun,
    lastHousekeeping = 0;
  const renewed = { $add: ["$$NOW", lease] };
  async function status() {
    const record = await control.findOne(
      { _id: "latest" },
      { projection: { _id: 0, eventId: 0, leaseUntil: 0, recoveryId: 0 } },
    );
    return record ?? null;
  }
  async function finish(runId, values) {
    await control.updateOne(ownedLease(runId), [
      {
        $replaceWith: {
          $mergeObjects: [
            "$$ROOT",
            { $literal: values },
            {
              state: {
                $cond: [
                  { $eq: ["$state", "cancelling"] },
                  "cancelled",
                  values.state,
                ],
              },
              finishedAt: "$$NOW",
            },
          ],
        },
      },
      { $unset: "leaseUntil" },
    ]);
  }
  const ownedLease = (runId) => ({
    _id: "latest",
    runId,
    state: { $in: ["running", "cancelling"] },
    $expr: { $gt: ["$leaseUntil", "$$NOW"] },
  });
  async function run(record, controller) {
    const { runId, eventId, config } = record;
    let heartbeatBusy = false;
    const beat = async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        const row = await control.findOneAndUpdate(
          ownedLease(runId),
          [{ $set: { leaseUntil: renewed } }],
          { returnDocument: "after" },
        );
        if (!row) controller.abort("lease lost");
        else if (row.state === "cancelling") controller.abort(cancelled);
      } catch {
        controller.abort();
      } finally {
        heartbeatBusy = false;
      }
    };
    const timer = setInterval(beat, 10000);
    try {
      const result = await execute({
        models,
        connection,
        config,
        runId,
        eventId,
        hosted: true,
        signal: controller.signal,
        onProgress: async (progress) => {
          const changed = await control.updateOne(
            {
              ...ownedLease(runId),
              state: "running",
            },
            [
              {
                $set: {
                  progress: { $literal: progress },
                  traffic: { $literal: measure() },
                  leaseUntil: renewed,
                },
              },
            ],
          );
          if (!changed.matchedCount) {
            controller.abort();
            controller.signal.throwIfAborted();
          }
        },
      });
      await cleanFixture(models, runId, eventId);
      await finish(runId, {
        state:
          controller.signal.reason === cancelled
            ? "cancelled"
            : controller.signal.aborted || result.failures.length
              ? "failed"
              : "completed",
        result,
        cleanup: "complete",
        traffic: measure(),
      });
    } catch {
      try {
        await cleanFixture(models, runId, eventId);
        await finish(runId, {
          state:
            controller.signal.reason === cancelled ? "cancelled" : "failed",
          message:
            controller.signal.reason === cancelled
              ? "Run stopped."
              : "Simulation failed. Review the last recorded phase and retry.",
          cleanup: "complete",
          traffic: measure(),
        });
      } catch {
        await control.updateOne(ownedLease(runId), {
          $set: {
            state: "recovering",
            cleanup: "pending",
            leaseUntil: new Date(0),
          },
        });
      }
    } finally {
      clearInterval(timer);
      if (localRun === runId) localRun = null;
    }
  }
  async function start(input) {
    const options = validate(demoInput, input);
    const busy = () =>
      new HttpError(409, "SIMULATION_BUSY", "A simulation is already active.");
    if (localRun) throw busy();
    const runId = randomUUID(),
      eventId = new Types.ObjectId();
    const record = {
      runId,
      eventId,
      config: {
        ...options,
        columns: 10,
        aisleAfter: 4,
        maxActive: 4,
        perUser: 2,
        concurrency: 2,
        profile: "mixed",
        seed: runId,
      },
      startedAt: new Date(),
      state: "running",
      cleanup: "pending",
      progress: null,
      result: null,
      message: null,
      traffic: null,
      finishedAt: null,
    };
    try {
      await control.updateOne(
        { _id: "latest", state: { $nin: active } },
        [
          {
            $replaceWith: {
              $mergeObjects: [
                "$$ROOT",
                { $literal: record },
                { leaseUntil: renewed },
              ],
            },
          },
        ],
        { upsert: true },
      );
    } catch (error) {
      if (error.code === 11000) throw busy();
      throw error;
    }
    beginMeasure();
    localRun = runId;
    controller = new AbortController();
    work = run(record, controller);
    work.catch(() => {});
    return { runId, state: "running" };
  }
  async function cancel(runId) {
    const result = await control.updateOne(ownedLease(runId), {
      $set: { state: "cancelling" },
    });
    if (!result.matchedCount)
      throw new HttpError(
        409,
        "SIMULATION_ENDED",
        "This run is no longer active.",
      );
    if (localRun === runId) controller.abort(cancelled);
    return { runId, state: "cancelling" };
  }
  async function maintenance() {
    if (localRun) {
      const runId = localRun;
      if (!(await control.findOne(ownedLease(runId))) && localRun === runId)
        controller.abort();
      return;
    }
    const recoveryId = randomUUID();
    const stale = await control.findOneAndUpdate(
      {
        _id: "latest",
        state: { $in: active },
        $expr: { $lte: ["$leaseUntil", "$$NOW"] },
      },
      [{ $set: { state: "recovering", recoveryId, leaseUntil: renewed } }],
      { returnDocument: "after" },
    );
    if (stale) {
      await cleanFixture(models, stale.runId, stale.eventId);
      await control.updateOne(
        { _id: "latest", runId: stale.runId, recoveryId },
        {
          $set: {
            state: "failed",
            cleanup: "complete",
            message:
              "The worker stopped before finishing. Run data was removed.",
            finishedAt: new Date(),
          },
          $unset: { leaseUntil: 1, recoveryId: 1 },
        },
      );
    }
    if (Date.now() - lastHousekeeping < day) return;
    const current = await control.findOne({
      _id: "latest",
      state: { $in: active },
    });
    const filter = {
      createdAt: { $lt: new Date(Date.now() - day) },
      simRunId: { $type: "string", ...(current && { $ne: current.runId }) },
    };
    for await (const e of models.Event.find({ ...filter, isSimulation: true })
      .select("simRunId")
      .lean()
      .cursor())
      await cleanFixture(models, e.simRunId, e._id);
    for (const simRunId of await models.User.distinct("simRunId", {
      ...filter,
      isBot: true,
    }))
      await models.User.deleteMany({ ...filter, simRunId, isBot: true });
    lastHousekeeping = Date.now();
  }
  return {
    start,
    cancel,
    status,
    maintenance,
    idle: () => work,
    async shutdown() {
      if (localRun) controller.abort();
      await work;
    },
  };
}
