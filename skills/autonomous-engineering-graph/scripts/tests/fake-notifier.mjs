#!/usr/bin/env node

import { appendFile } from "node:fs/promises";

const target = process.env.AEG_FAKE_NOTIFICATION_LOG;
if (!target) throw new Error("AEG_FAKE_NOTIFICATION_LOG is required");
await appendFile(
  target,
  `${JSON.stringify({
    run_id: process.env.GRAPH_RUN_ID,
    status: process.env.GRAPH_STATUS,
    workspace: process.env.GRAPH_WORKSPACE,
    report: process.env.GRAPH_REPORT,
    completion: process.env.GRAPH_COMPLETION_JSON,
  })}\n`,
  "utf8",
);
