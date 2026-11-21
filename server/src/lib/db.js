import { setTimeout as sleep } from "node:timers/promises";
import mongoose from "mongoose";
import { systemClock } from "./clock.js";

const transient = "TransientTransactionError";
const unknownCommit = "UnknownTransactionCommitResult";
const hasLabel = (error, label) => error?.hasErrorLabel?.(label) === true;

export async function connectMongo(uri, options = {}) {
  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 6000,
    connectTimeoutMS: 3000,
    socketTimeoutMS: 3000,
    timeoutMS: 2500,
    maxPoolSize: 10,
    ...options,
  });
  try {
    return await connection.asPromise();
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

export function remainingTime(deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0)
    throw transactionError(
      "DB_DEADLINE_EXCEEDED",
      "Database operation exceeded its time budget.",
    );
  return remaining;
}

function transactionError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

export async function withTxn(
  work,
  { connection, clock = systemClock, timeoutMs = 8000, pause = sleep },
) {
  const deadline = performance.now() + timeoutMs;
  let retries = 0;

  async function backoff() {
    const delay = 25 * 2 ** retries;
    if (retries >= 5 || performance.now() + delay >= deadline) return false;
    retries += 1;
    await pause(delay);
    return performance.now() < deadline;
  }

  const session = await connection.startSession();
  let result;
  let effects;
  try {
    for (;;) {
      const maxCommitTimeMS = Math.min(2000, remainingTime(deadline));
      effects = [];
      session.startTransaction({
        maxCommitTimeMS,
        writeConcern: { w: "majority" },
      });
      let uncertainCommit;
      try {
        result = await work({
          session,
          now: clock.now(),
          afterCommit: (effect) => effects.push(effect),
        });

        for (;;) {
          try {
            remainingTime(deadline);
            await session.commitTransaction();
            break;
          } catch (error) {
            // A lost commit reply can only be resolved by retrying commit on this transaction.
            if (hasLabel(error, unknownCommit)) {
              uncertainCommit = error;
              if (await backoff()) continue;
            }
            if (uncertainCommit) {
              throw transactionError(
                "TXN_COMMIT_UNCONFIRMED",
                "Commit outcome is unknown. Reconcile persisted state before retrying.",
                uncertainCommit,
              );
            }
            throw error;
          }
        }
        break;
      } catch (error) {
        if (uncertainCommit) throw error;
        if (session.inTransaction())
          await session.abortTransaction().catch(() => {});
        if (!hasLabel(error, transient)) throw error;
        if (!(await backoff())) {
          throw transactionError(
            "TXN_RETRIES_EXHAUSTED",
            "Transient transaction retries exhausted.",
            error,
          );
        }
      }
    }
  } finally {
    await session.endSession().catch(() => {});
  }

  const failures = [];
  for (const effect of effects) {
    try {
      await effect();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw Object.assign(
      transactionError(
        "TXN_AFTER_COMMIT_FAILED",
        "Transaction committed with a failed follow-up action.",
        new AggregateError(failures),
      ),
      { committed: true },
    );
  }
  return result;
}
