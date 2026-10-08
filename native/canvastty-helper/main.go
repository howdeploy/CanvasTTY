// canvastty-helper is the native form of the helpers CanvasTTY starts inside agent processes. Each subcommand speaks
// exactly the wire protocol of its JavaScript original, which stays the reference and the fallback:
//
//	canvastty-helper mcp-browser                src/agent-browser/mcp-helper.mjs
//	canvastty-helper mcp-orchestration          src/agent-browser/orchestration-helper.mjs
//	canvastty-helper permission-gate pretool    src/agent-runtime/permission-gate.mjs
//	canvastty-helper hook <state> <event>       src/agent-runtime/hook-helper.mjs
//	canvastty-helper version                    prints the helper protocol version
//
// It uses only the Go standard library, never cgo, and reads no file.
package main

import (
	"os"
)

// helperVersion changes whenever a subcommand's behavior changes; the app reads it to check the binary it ships.
const helperVersion = "canvastty-helper 1"

func main() {
	if len(os.Args) < 2 {
		os.Stderr.WriteString("usage: canvastty-helper mcp-browser | mcp-orchestration | permission-gate pretool | hook <state> <event> | network-bridge | version\n")
		os.Exit(2)
	}
	args := os.Args[2:]
	switch os.Args[1] {
	case "mcp-browser":
		os.Exit(runBrowserMCP())
	case "mcp-orchestration":
		os.Exit(runOrchestrationMCP())
	case "permission-gate":
		os.Exit(runPermissionGate(args))
	case "hook":
		os.Exit(runHook(args))
	case "network-bridge":
		os.Exit(runNetworkBridge(args))
	case "version":
		os.Stdout.WriteString(helperVersion + "\n")
		os.Exit(0)
	}
	os.Stderr.WriteString("canvastty-helper: unknown subcommand\n")
	os.Exit(2)
}
