import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectMongo } from "../../server/src/lib/db.js";
import { initializeModels } from "../../server/src/modules/models.js";
import { assertDisposable } from "./options.js";
export async function withDisposable(work) {
  const replica = await MongoMemoryReplSet.create({
    binary: { version: "7.0.24" },
    replSet: { count: 1, ip: "127.0.0.1" },
  });
  let connection;
  try {
    const name = "qt_proof_" + randomUUID().replaceAll("-", "");
    const uri = replica.getUri(name);
    assertDisposable(uri, name);
    connection = await connectMongo(uri);
    const models = await initializeModels(connection);
    return await work({ connection, models });
  } finally {
    try {
      await connection?.close();
    } finally {
      await replica.stop();
    }
  }
}
