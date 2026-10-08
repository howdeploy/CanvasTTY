//go:build !linux

package main

import (
	"fmt"
	"os"
)

func runNetworkBridge(_ []string) int {
	fmt.Fprintln(os.Stderr, "canvastty-helper network-bridge is available on Linux only")
	return 2
}
