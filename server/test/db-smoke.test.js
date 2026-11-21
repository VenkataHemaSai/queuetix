import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createDbStatus, runDbSmoke } from "../src/health/db-smoke.js";
import { createFakeClock } from "../src/lib/clock.js";
import { connectMongo, withTxn } from "../src/lib/db.js";

let replSet;
let connection;
const clock = createFakeClock("2026-11-21T12:00:00.000Z");
const names = ["smoke", "smoke_a", "smoke_b"];

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  connection = await connectMongo(replSet.getUri("tickets_dev"), {
    monitorCommands: true,
  });
});

afterAll(async () => {
  await connection?.close();
  await replSet?.stop();
});

test("T-SMOKE-SEC-2 reports a real commit, outside-transaction readback and cleanup", async () => {
  const commands = [];
  const listener = (event) => commands.push(event);
  connection.getClient().on("commandStarted", listener);
  const dbStatus = createDbStatus();
  const app = createApp({ clock, clientOrigins: [], dbStatus });
  try {
    const result = await runDbSmoke({ connection, clock });
    dbStatus.store(result);
    expect(result).toMatchObject({
      ok: true,
      mongo: true,
      txn: true,
      latencyMs: expect.any(Number),
      checkedAt: "2026-11-21T12:00:00.000Z",
    });
    const commit = commands.findIndex(
      ({ commandName }) => commandName === "commitTransaction",
    );
    expect(commit).toBeGreaterThan(0);
    expect(
      commands
        .slice(0, commit)
        .filter(
          ({ commandName, command }) =>
            commandName === "insert" && command.autocommit === false,
        )
        .map(({ command }) => command.insert),
    ).toEqual(["smoke_a", "smoke_b"]);
    expect(
      commands
        .slice(commit + 1)
        .filter(
          ({ commandName, command }) =>
            commandName === "find" && command.autocommit === undefined,
        )
        .map(({ command }) => command.find),
    ).toEqual(["smoke_a", "smoke_b"]);
    for (const name of names)
      expect(await connection.db.collection(name).countDocuments()).toBe(0);
    clock.advance(60_000);
    const response = await request(app).get("/health/db").expect(200);
    expect(response.body).toEqual(result);
  } finally {
    connection.getClient().off("commandStarted", listener);
  }
});

test("T-SMOKE-SEC-1 100 anonymous reads produce zero MongoDB commands", async () => {
  const dbStatus = createDbStatus();
  dbStatus.store(await runDbSmoke({ connection, clock }));
  const app = createApp({ clock, clientOrigins: [], dbStatus });
  const commands = [];
  const listener = ({ commandName }) => commands.push(commandName);
  connection.getClient().on("commandStarted", listener);
  try {
    for (let batch = 0; batch < 10; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app).get("/health/db").expect(200),
        ),
      );
    }
    expect(commands).toEqual([]);
  } finally {
    connection.getClient().off("commandStarted", listener);
  }
});

test("a failed transactional step aborts and cleans up only the current probe records", async () => {
  const collection = connection.db.collection("smoke");
  await collection.insertOne({ _id: "unrelated" });
  const diagnostic = jestDiagnostic();
  try {
    const result = await runDbSmoke({
      connection,
      clock,
      reportFailure: diagnostic.report,
      async transaction(work, options) {
        return withTxn(async (context) => {
          await work(context);
          throw new Error(
            "probe fault mongodb+srv://user:private@internal.example/tickets_prod",
          );
        }, options);
      },
    });
    expect(result).toMatchObject({
      ok: false,
      mongo: true,
      txn: false,
      code: "DB_SMOKE_TRANSACTION_FAILED",
    });
    expect(JSON.stringify(result)).not.toMatch(/private|internal\.example/);
    expect(diagnostic.entries[0].message).toBe(
      "probe fault [redacted MongoDB URI]",
    );
    expect(await collection.find().toArray()).toEqual([{ _id: "unrelated" }]);
    for (const name of names.slice(1))
      expect(await connection.db.collection(name).countDocuments()).toBe(0);
  } finally {
    await collection.deleteOne({ _id: "unrelated" });
  }
});

test("a transient write conflict and a lost commit reply preserve one durable effect", async () => {
  const transitions = await connection.db.createCollection("test_transitions");
  const audit = await connection.db.createCollection("test_audit");
  const session = await connection.startSession();
  const commit = session.commitTransaction.bind(session);
  let commitCalls = 0;
  session.commitTransaction = async () => {
    await commit();
    commitCalls += 1;
    if (commitCalls === 1) {
      throw new mongoose.mongo.MongoServerError({
        message: "Simulated lost commit reply",
        errorLabels: ["UnknownTransactionCommitResult"],
      });
    }
  };

  let attempts = 0;
  const sent = [];
  await withTxn(
    async ({ session: active, afterCommit }) => {
      attempts += 1;
      await transitions.insertOne({ state: "confirmed" }, { session: active });
      await audit.insertOne({ event: "confirmed" }, { session: active });
      afterCommit(() => sent.push("SSE"));
      afterCommit(() => sent.push("notification"));
      if (attempts === 1) {
        throw new mongoose.mongo.MongoServerError({
          message: "Simulated write conflict",
          code: 112,
          errorLabels: ["TransientTransactionError"],
        });
      }
    },
    { connection: { startSession: async () => session }, clock },
  );

  expect(attempts).toBe(2);
  expect(commitCalls).toBe(2);
  expect(await transitions.countDocuments({ state: "confirmed" })).toBe(1);
  expect(await audit.countDocuments({ event: "confirmed" })).toBe(1);
  expect(sent).toEqual(["SSE", "notification"]);
});

function jestDiagnostic() {
  const entries = [];
  return { entries, report: (entry) => entries.push(entry) };
}
