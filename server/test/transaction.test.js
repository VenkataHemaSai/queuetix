import { jest } from "@jest/globals";
import { withTxn } from "../src/lib/db.js";
import { createFakeClock } from "../src/lib/clock.js";

const transient = "TransientTransactionError";
const unknownCommit = "UnknownTransactionCommitResult";

function labeled(label) {
  return Object.assign(new Error(label), {
    hasErrorLabel: (value) => value === label,
  });
}

function fixture() {
  const clock = createFakeClock(0);
  const pending = [];
  const state = [];
  const session = {
    startTransaction: jest.fn(() => {
      pending.length = 0;
    }),
    abortTransaction: jest.fn(async () => {
      pending.length = 0;
    }),
    commitTransaction: jest.fn(async () => {
      state.push(...pending.splice(0));
    }),
    inTransaction: jest.fn(() => true),
    endSession: jest.fn(async () => {}),
  };
  const options = {
    connection: { startSession: async () => session },
    clock,
    pause: async () => clock.advance(50),
  };
  return { options, pending, session, state };
}

test("T-TXN-1 a write conflict retries the body and drops the failed attempt’s effects", async () => {
  const { options, pending, session, state } = fixture();
  const broadcast = jest.fn();
  const audit = jest.fn();
  const attempts = [];
  const result = await withTxn(
    async ({ session: active, now, afterCommit }) => {
      expect(active).toBe(session);
      attempts.push(now.getTime());
      pending.push("transition", "audit row");
      afterCommit(audit);
      afterCommit(broadcast);
      if (attempts.length === 1) throw labeled(transient);
      return "confirmed";
    },
    options,
  );
  expect(result).toBe("confirmed");
  expect(attempts).toEqual([0, 50]);
  expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  expect(state).toEqual(["transition", "audit row"]);
  expect(audit).toHaveBeenCalledTimes(1);
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(session.endSession).toHaveBeenCalledTimes(1);
});

test("T-TXN-2 uncertain commit retries only commit on the same transaction", async () => {
  const { options, pending, session, state } = fixture();
  const notify = jest.fn();
  session.commitTransaction.mockImplementationOnce(async () => {
    state.push(...pending.splice(0));
    throw labeled(unknownCommit);
  });
  const work = jest.fn(async ({ afterCommit }) => {
    pending.push("transition", "audit row");
    afterCommit(notify);
  });
  await withTxn(work, options);
  expect(work).toHaveBeenCalledTimes(1);
  expect(session.startTransaction).toHaveBeenCalledTimes(1);
  expect(session.commitTransaction).toHaveBeenCalledTimes(2);
  expect(session.abortTransaction).not.toHaveBeenCalled();
  expect(state).toEqual(["transition", "audit row"]);
  expect(notify).toHaveBeenCalledTimes(1);
});

test("T-TXN-3 exhausted commit uncertainty reports reconciliation without replay or effects", async () => {
  const { options, session } = fixture();
  const notify = jest.fn();
  session.commitTransaction.mockRejectedValue(labeled(unknownCommit));
  const work = jest.fn(async ({ afterCommit }) => afterCommit(notify));
  await expect(withTxn(work, options)).rejects.toMatchObject({
    code: "TXN_COMMIT_UNCONFIRMED",
  });
  expect(work).toHaveBeenCalledTimes(1);
  expect(session.commitTransaction).toHaveBeenCalledTimes(6);
  expect(session.abortTransaction).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

test("T-TXN-4 caps transient retries and never retries a failed post-commit effect", async () => {
  const { options, session } = fixture();
  const retry = jest.fn(async () => {
    throw labeled(transient);
  });
  await expect(withTxn(retry, options)).rejects.toMatchObject({
    code: "TXN_RETRIES_EXHAUSTED",
  });
  expect(retry).toHaveBeenCalledTimes(6);
  expect(session.commitTransaction).not.toHaveBeenCalled();
  const after = jest.fn();
  const work = jest.fn(async ({ afterCommit }) => {
    afterCommit(() => {
      throw labeled(transient);
    });
    afterCommit(after);
  });
  await expect(withTxn(work, options)).rejects.toMatchObject({
    code: "TXN_AFTER_COMMIT_FAILED",
    committed: true,
  });
  expect(work).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
  expect(session.commitTransaction).toHaveBeenCalledTimes(1);
});

test("T-TXN-5 does not replay a known non-retryable error", async () => {
  const { options, session } = fixture();
  const conflict = new Error("business conflict");
  const work = jest.fn(async () => {
    throw conflict;
  });
  await expect(withTxn(work, options)).rejects.toBe(conflict);
  expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  expect(work).toHaveBeenCalledTimes(1);
});
