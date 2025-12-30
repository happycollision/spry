import { beforeEach } from "bun:test";
import { clearConfigCache } from "../src/git/config.ts";

// Clear config cache before each test to ensure test isolation
beforeEach(() => {
  clearConfigCache();
});
