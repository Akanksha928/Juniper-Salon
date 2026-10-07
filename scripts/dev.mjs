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
// On Windows npm is npm.cmd, which Node can only start through a shell. The
// command is passed as one fixed string, since a shell with separate
// arguments is deprecated.
const isWindows = process.platform === "win32";
const npmRun = (script) =>
  isWindows
    ? spawn(`npm run ${script}`, { stdio: "inherit", shell: true })
    : spawn("npm", ["run", script], { stdio: "inherit" });
const children = [npmRun("dev:worker"), npmRun("dev:api")];
// Killing the shell on Windows would leave the Worker and API running, so
// end each whole process tree instead.
function stop(child) {
  if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}
let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stop(child);
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
console.log("\nJuniper Salon waitlist is starting:");
console.log("  App:         http://localhost:3000");
console.log("  Temporal UI: http://localhost:8233\n");

