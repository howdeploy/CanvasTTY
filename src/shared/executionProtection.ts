/** Evidence from a successfully constructed host wrapper, never a requested setting or remote environment claim. */
export type ExecutionProtection = Readonly<{ state: "unverified" }> | Readonly<{
  state: "applied";
  location: "local";
  layer: "seatbelt" | "bubblewrap";
  filesystem: "read-only-project" | "project-and-runtime";
  network: "open" | "offline" | "allowed-domains";
}>;
export const UNVERIFIED_EXECUTION_PROTECTION: ExecutionProtection = Object.freeze({ state: "unverified" });
