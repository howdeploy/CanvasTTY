//go:build linux

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var networkTokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type repeatedStrings []string

func (values *repeatedStrings) String() string { return strings.Join(*values, ",") }
func (values *repeatedStrings) Set(value string) error {
	*values = append(*values, value)
	return nil
}

// runNetworkBridge enforces the Unix-socket boundary before creating any listener, goroutine, or child. The strict
// network modes share the same ABI-9 Landlock guard; offline skips the TCP proxy entirely.
func runNetworkBridge(arguments []string) int {
	if len(arguments) == 1 && arguments[0] == "--probe" {
		if err := installUnixSocketGuard(nil); err != nil {
			fmt.Fprintf(os.Stderr, "canvastty-helper network-bridge: Unix socket guard is unavailable: %v\n", err)
			return 1
		}
		return 0
	}

	separator := -1
	for index, argument := range arguments {
		if argument == "--" {
			separator = index
			break
		}
	}
	if separator < 0 {
		fmt.Fprintln(os.Stderr, "canvastty-helper network-bridge: expected --offline or --socket PATH --token TOKEN, followed by [--allow-socket PATH]* -- COMMAND [ARGUMENTS]")
		return 2
	}

	flags := flag.NewFlagSet("network-bridge", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var socket, token string
	var offline bool
	var allowedSockets repeatedStrings
	flags.StringVar(&socket, "socket", "", "host allowlist proxy Unix socket")
	flags.StringVar(&token, "token", "", "single-launch proxy capability")
	flags.BoolVar(&offline, "offline", false, "disable the TCP proxy")
	flags.Var(&allowedSockets, "allow-socket", "exact host-selected Unix socket path (repeatable)")
	if err := flags.Parse(arguments[:separator]); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "canvastty-helper network-bridge: options must precede -- COMMAND")
		return 2
	}
	command := arguments[separator+1:]
	if len(command) == 0 {
		fmt.Fprintln(os.Stderr, "canvastty-helper network-bridge: expected a command after --")
		return 2
	}

	if offline {
		if socket != "" || token != "" {
			fmt.Fprintln(os.Stderr, "canvastty-helper network-bridge: --offline cannot be combined with --socket or --token")
			return 2
		}
	} else if socket == "" || !networkTokenPattern.MatchString(token) || !strings.HasPrefix(socket, "/") {
		fmt.Fprintln(os.Stderr, "canvastty-helper network-bridge: allowed-domains mode requires --socket PATH --token TOKEN")
		return 2
	}
	for _, path := range allowedSockets {
		if path == "" || !strings.HasPrefix(path, "/") {
			fmt.Fprintln(os.Stderr, "canvastty-helper network-bridge: every --allow-socket path must be absolute")
			return 2
		}
	}
	grants := append([]string(nil), allowedSockets...)
	if !offline {
		grants = append(grants, socket)
	}
	if err := installUnixSocketGuard(grants); err != nil {
		fmt.Fprintf(os.Stderr, "canvastty-helper network-bridge: Unix socket guard is unavailable: %v\n", err)
		return 1
	}

	if offline {
		environment := withoutProxy(os.Environ())
		environment = append(environment, "CANVASTTY_NETWORK_MODE=offline")
		return runNetworkBridgeChild(command, environment)
	}

	if err := bringLoopbackUp(); err != nil {
		fmt.Fprintf(os.Stderr, "canvastty-helper network-bridge: private loopback is unavailable: %v\n", err)
		return 1
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "canvastty-helper network-bridge: private proxy listener could not start: %v\n", err)
		return 1
	}
	defer listener.Close()
	go acceptProxyClients(listener, socket)

	proxy := "http://canvastty:" + token + "@" + listener.Addr().String()
	environment := withoutProxy(os.Environ())
	environment = append(environment,
		"HTTP_PROXY="+proxy, "http_proxy="+proxy,
		"HTTPS_PROXY="+proxy, "https_proxy="+proxy,
		"ALL_PROXY="+proxy, "all_proxy="+proxy,
		"NO_PROXY=", "no_proxy=", "CANVASTTY_NETWORK_MODE=allowed-domains")
	return runNetworkBridgeChild(command, environment)
}

func runNetworkBridgeChild(command, environment []string) int {
	child := exec.Command(command[0], command[1:]...)
	child.Env = environment
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := child.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "canvastty-helper network-bridge: agent could not start: %v\n", err)
		return 127
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	done := make(chan struct{})
	go func() {
		select {
		case received := <-signals:
			_ = child.Process.Signal(received)
		case <-done:
		}
	}()
	err := child.Wait()
	close(done)
	signal.Stop(signals)
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Exited() {
			return status.ExitStatus()
		}
		if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
	}
	fmt.Fprintf(os.Stderr, "canvastty-helper network-bridge: agent failed: %v\n", err)
	return 1
}

func acceptProxyClients(listener net.Listener, socket string) {
	for {
		client, err := listener.Accept()
		if err != nil {
			return
		}
		go bridgeConnection(client, socket)
	}
}

func bridgeConnection(client net.Conn, socket string) {
	defer client.Close()
	upstream, err := net.DialTimeout("unix", socket, 5*time.Second)
	if err != nil {
		return
	}
	defer upstream.Close()
	finished := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, client)
		if closer, ok := upstream.(*net.UnixConn); ok {
			_ = closer.CloseWrite()
		}
		finished <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		if closer, ok := client.(*net.TCPConn); ok {
			_ = closer.CloseWrite()
		}
		finished <- struct{}{}
	}()
	<-finished
	<-finished
}

func withoutProxy(environment []string) []string {
	kept := make([]string, 0, len(environment)+9)
	for _, item := range environment {
		key, _, found := strings.Cut(item, "=")
		if found && (strings.EqualFold(key, "http_proxy") || strings.EqualFold(key, "https_proxy") || strings.EqualFold(key, "all_proxy") || strings.EqualFold(key, "no_proxy")) {
			continue
		}
		kept = append(kept, item)
	}
	return kept
}

// bubblewrap's fresh network namespace starts with loopback down. Bring only that interface up; no physical or
// host interface is joined. If the namespace lacks CAP_NET_ADMIN, strict mode refuses before starting the agent.
func bringLoopbackUp() error {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var request [40]byte // Linux ifreq: 16-byte name followed by a 24-byte union.
	copy(request[:16], "lo")
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(0x8913), uintptr(unsafe.Pointer(&request[0]))); errno != 0 { // SIOCGIFFLAGS
		return errno
	}
	flags := *(*uint16)(unsafe.Pointer(&request[16]))
	if flags&0x1 != 0 { // IFF_UP
		return nil
	}
	flags |= 0x1
	*(*uint16)(unsafe.Pointer(&request[16])) = flags
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(0x8914), uintptr(unsafe.Pointer(&request[0]))); errno != 0 { // SIOCSIFFLAGS
		return errno
	}
	return nil
}
