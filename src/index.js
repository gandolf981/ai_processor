/**
 * Entry point: load env, bootstrap View + Controller.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { runWorkerForever } from "./controllers/workerController.js";
import { createWorkerLogView } from "./views/workerLogView.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config();

const view = createWorkerLogView();

runWorkerForever(view).catch((err) => {
  view.error("worker crashed", err);
  process.exit(1);
});
