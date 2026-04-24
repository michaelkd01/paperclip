export { cleanup, type CleanupResult, type CleanupOptions } from "./cleanup.js";
export { run } from "./run.js";

// Run when invoked directly
import { run } from "./run.js";

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
