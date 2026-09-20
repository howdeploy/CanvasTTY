import { spawn, type ChildProcess } from "node:child_process";
import { LOCAL_DISCOVERY_HOSTS } from "../../../shared/localDiscovery.ts";

/** Publish a bounded local hostname through macOS Bonjour, scoped to Wi-Fi. */
export class LocalDiscovery {
  private child: ChildProcess | null = null;
  private epoch = 0;
  host = "";
  stop() {
    this.epoch++;
    this.host = "";
    this.child?.kill();
    this.child = null;
  }
  async start(address: string, interfaceName: string, port: number): Promise<void> {
    this.stop();
    if (process.platform !== "darwin" || port !== 3481)
      throw new Error("local-discovery-unavailable");
    const epoch = this.epoch;
    for (const host of LOCAL_DISCOVERY_HOSTS) {
      if (this.epoch !== epoch) throw new Error("discovery-cancelled");
      const child = spawn("/usr/bin/dns-sd", ["-i", interfaceName, "-P",
        `CanvasTTY ${host}`, "_canvastty._tcp", "local", String(port), host, address],
      { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      let settled = false;
      const result = await new Promise<"ready" | "conflict" | "failed">(resolve => {
        const timer = setTimeout(() => done("failed"), 5000);
        let output = "";
        const done = (value: "ready" | "conflict" | "failed") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        child.stdout?.on("data", data => {
          output = (output + data.toString()).slice(-4096);
          if (output.includes("Name in use")) done("conflict");
          else if (output.includes(`record ${host}: Name now registered and active`)) done("ready");
        });
        child.on("error", () => done("failed"));
        child.on("exit", () => {
          if (this.child === child) { this.child = null; this.host = ""; }
          done("failed");
        });
      });
      if (this.epoch !== epoch) { child.kill(); throw new Error("discovery-cancelled"); }
      if (result === "ready") { this.host = host; return; }
      child.kill();
      if (result !== "conflict") break;
    }
    throw new Error("local-discovery-unavailable");
  }
}
