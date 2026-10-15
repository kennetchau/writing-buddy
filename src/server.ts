import { boot } from "./app";

boot().catch((err) => {
  console.error("[app] failed to boot:", err);
  process.exit(1);
});
