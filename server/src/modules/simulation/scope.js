export function simulationTarget(uri, env) {
  try {
    const target = new URL(uri);
    if (
      target.protocol === "mongodb:" &&
      target.hostname === "127.0.0.1" &&
      /^\/qt_proof_[a-z0-9]+$/.test(target.pathname) &&
      target.searchParams.get("replicaSet")
    )
      return "local";
    if (
      env.NODE_ENV === "production" &&
      env.RENDER === "true" &&
      env.IS_PULL_REQUEST !== "true" &&
      target.protocol === "mongodb+srv:" &&
      target.pathname === "/tickets_prod"
    )
      return "hosted";
  } catch {
    /* An unrecognized target cannot host simulation data. */
  }
  return null;
}

export function assertSimulationStore(models, connection = models.User?.db) {
  const collections = Object.values(models);
  if (
    collections.length &&
    collections.every((model) => model.collection.name.startsWith("qt_sim_"))
  )
    return;
  if (
    connection?.host === "127.0.0.1" &&
    /^qt_proof_[a-z0-9]+$/.test(connection.name) &&
    connection.getClient().options.replicaSet
  )
    return;
  throw Error(
    "Simulation requires isolated collections or a disposable loopback proof database.",
  );
}
