#!/usr/bin/env node
import { runLoginFlow } from "./auth/session.js";

runLoginFlow().catch((error) => {
  console.error(error);
  process.exit(1);
});
