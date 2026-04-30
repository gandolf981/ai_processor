/**
 * Presentation layer: structured console output for the worker (View).
 */

function ts() {
  const d = new Date();
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function safeRepr(s, limit = 120) {
  try {
    const preview = String(s).slice(0, limit);
    return Buffer.from(preview, "utf8").toString("utf8");
  } catch {
    return "";
  }
}

export function createWorkerLogView() {
  return {
    info(msg) {
      console.log(`${ts()} | INFO | worker | ${msg}`);
    },
    warn(msg) {
      console.warn(`${ts()} | WARN | worker | ${msg}`);
    },
    error(msg, err) {
      console.error(`${ts()} | ERROR | worker | ${msg}`);
      if (err != null) console.error(err);
    },
    debug(msg) {
      if (process.env.DEBUG_WORKER === "1") {
        console.log(`${ts()} | DEBUG | worker | ${msg}`);
      }
    },
    safeRepr,
  };
}
