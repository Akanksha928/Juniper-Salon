import { connect } from "node:net";
import { spawn, spawnSync } from "node:child_process";

const compose = spawnSync("docker", ["compose", "up", "-d", "temporal"], {
  stdio: "inherit",
});
if (compose.status !== 0) {
  console.error("\nCould not start Temporal. Is Docker Desktop running?");
  process.exit(compose.status ?? 1);
}

async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Temporal did not become ready on port ${port}.`);
}

await waitForPort(7233);
const children = [
  spawn("npm", ["run", "dev:worker"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:api"], { stdio: "inherit" }),
];
let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const child of children) {
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`A development process stopped (${signal ?? code}).`);
      shutdown(code ?? 1);
    }
  });
}
console.log("\nStarter is launching:");
console.log("  App:         http://localhost:3000");
console.log("  Temporal UI: http://localhost:8233\n");

