//go:build linux

package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	networkBridgeTestRoleEnv        = "CANVASTTY_NETWORK_BRIDGE_TEST_ROLE"
	networkBridgeTestModeEnv        = "CANVASTTY_NETWORK_BRIDGE_TEST_MODE"
	networkBridgeTestGatewayEnv     = "CANVASTTY_NETWORK_BRIDGE_TEST_GATEWAY"
	networkBridgeTestDeniedEnv      = "CANVASTTY_NETWORK_BRIDGE_TEST_DENIED"
	networkBridgeTestAliasEnv       = "CANVASTTY_NETWORK_BRIDGE_TEST_ALIAS"
	networkBridgeTestAbstractEnv    = "CANVASTTY_NETWORK_BRIDGE_TEST_ABSTRACT"
	networkBridgeTestProxySocketEnv = "CANVASTTY_NETWORK_BRIDGE_TEST_PROXY_SOCKET"
	networkBridgeTestFDTargetEnv    = "CANVASTTY_NETWORK_BRIDGE_TEST_FD_TARGET"
	networkBridgeTestProxyToken     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// One subprocess macro exercises the public network-bridge path without restricting the go test process itself.
// The parent owns fake external sockets; the helper receives a connected ExtraFiles descriptor, applies the guard,
// and execs this test binary as a small agent client. No app credentials or services are involved.
func TestNetworkBridgeLandlockIntegration(t *testing.T) {
	switch os.Getenv(networkBridgeTestRoleEnv) {
	case "helper":
		os.Exit(runNetworkBridgeTestHelper())
	case "client":
		if err := runNetworkBridgeTestClient(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	abi, err := landlockABIVersion()
	if err != nil {
		t.Fatalf("Landlock ABI query failed: %v", err)
	}
	if abi < 9 {
		t.Skipf("Landlock ABI %d is too old for pathname Unix-socket rules (need ABI 9)", abi)
	}

	socketDir := t.TempDir()
	approvedSocket := filepath.Join(socketDir, "gateway.sock")
	deniedSocket := filepath.Join(socketDir, "sibling.sock")
	aliasSocket := filepath.Join(socketDir, "sibling-alias.sock")
	proxySocket := filepath.Join(socketDir, "proxy.sock")
	approvedListener := startLandlockTestEcho(t, approvedSocket)
	defer approvedListener.Close()
	deniedListener := startLandlockTestEcho(t, deniedSocket)
	defer deniedListener.Close()
	if err := os.Symlink(deniedSocket, aliasSocket); err != nil {
		t.Fatal(err)
	}

	abstractSocket := fmt.Sprintf("@canvastty-landlock-%d-%d", os.Getpid(), time.Now().UnixNano())
	abstractListener, err := net.Listen("unix", abstractSocket)
	if err != nil {
		abstractSocket = "" // Abstract sockets are an optional assertion; pathname checks remain mandatory.
	} else {
		defer abstractListener.Close()
	}

	expectedAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("canvastty:"+networkBridgeTestProxyToken))
	proxyListener, err := net.Listen("unix", proxySocket)
	if err != nil {
		t.Fatal(err)
	}
	defer proxyListener.Close()
	go serveLandlockTestProxy(proxyListener, expectedAuth)

	connectedFDs, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	connectedFD := os.NewFile(uintptr(connectedFDs[0]), "inherited-connected-unix-socket")
	defer connectedFD.Close()
	defer syscall.Close(connectedFDs[1])
	fdTarget, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", connectedFD.Fd()))
	if err != nil || !strings.HasPrefix(fdTarget, "socket:[") {
		t.Fatalf("could not identify connected socketpair descriptor: target=%q err=%v", fdTarget, err)
	}

	for _, mode := range []string{"offline", "allowed-domains"} {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNetworkBridgeLandlockIntegration$")
		child.ExtraFiles = []*os.File{connectedFD}
		child.Env = os.Environ()
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestRoleEnv, "helper")
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestModeEnv, mode)
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestGatewayEnv, approvedSocket)
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestDeniedEnv, deniedSocket)
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestAliasEnv, aliasSocket)
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestAbstractEnv, abstractSocket)
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestProxySocketEnv, proxySocket)
		child.Env = setLandlockTestEnv(child.Env, networkBridgeTestFDTargetEnv, fdTarget)
		output, err := child.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("%s network-bridge integration failed: %v\n%s", mode, err, strings.TrimSpace(string(output)))
		}
		if len(output) != 0 {
			t.Fatalf("%s network-bridge integration wrote unexpected output: %q", mode, string(output))
		}
	}
}

func runNetworkBridgeTestHelper() int {
	fdTarget, err := os.Readlink("/proc/self/fd/3")
	if err != nil || fdTarget != os.Getenv(networkBridgeTestFDTargetEnv) {
		fmt.Fprintf(os.Stderr, "test helper did not receive the connected external socket on fd 3: target=%q err=%v\n", fdTarget, err)
		return 1
	}
	_ = os.Setenv(networkBridgeTestRoleEnv, "client")
	args := make([]string, 0, 10)
	if os.Getenv(networkBridgeTestModeEnv) == "offline" {
		args = append(args, "--offline")
	} else {
		args = append(args, "--socket", os.Getenv(networkBridgeTestProxySocketEnv), "--token", networkBridgeTestProxyToken)
	}
	args = append(args,
		"--allow-socket", os.Getenv(networkBridgeTestGatewayEnv),
		"--", os.Args[0], "-test.run=^TestNetworkBridgeLandlockIntegration$")
	return runNetworkBridge(args)
}

func runNetworkBridgeTestClient() error {
	fdTarget, err := os.Readlink("/proc/self/fd/3")
	if err == nil && fdTarget == os.Getenv(networkBridgeTestFDTargetEnv) {
		return fmt.Errorf("the inherited connected Unix socket reached the agent child")
	}
	if err != nil && !errors.Is(err, syscall.ENOENT) {
		return fmt.Errorf("could not verify inherited socket closure: %w", err)
	}

	mode := os.Getenv(networkBridgeTestModeEnv)
	if mode == "offline" {
		for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"} {
			if _, exists := os.LookupEnv(key); exists {
				return fmt.Errorf("offline mode retained proxy variable %s", key)
			}
		}
		if os.Getenv("CANVASTTY_NETWORK_MODE") != "offline" {
			return fmt.Errorf("offline mode environment marker was not set")
		}
	} else {
		proxy, parseErr := url.Parse(os.Getenv("HTTPS_PROXY"))
		if parseErr != nil || proxy.Scheme != "http" || proxy.Hostname() != "127.0.0.1" || proxy.Port() == "" {
			return fmt.Errorf("allowed-domains HTTPS_PROXY does not point to the helper's localhost listener: %q", os.Getenv("HTTPS_PROXY"))
		}
		if proxy.User == nil {
			return fmt.Errorf("allowed-domains proxy URL has no launch credentials")
		}
		user := proxy.User.Username()
		password, hasPassword := proxy.User.Password()
		if user != "canvastty" || !hasPassword || password != networkBridgeTestProxyToken ||
			os.Getenv("HTTP_PROXY") != os.Getenv("HTTPS_PROXY") || os.Getenv("https_proxy") != os.Getenv("HTTPS_PROXY") {
			return fmt.Errorf("allowed-domains proxy credentials or scheme variables do not match the launch token")
		}
		if os.Getenv("CANVASTTY_NETWORK_MODE") != "allowed-domains" {
			return fmt.Errorf("allowed-domains mode environment marker was not set")
		}
	}

	if err := roundTripLandlockTestSocket(os.Getenv(networkBridgeTestGatewayEnv)); err != nil {
		return fmt.Errorf("exact approved gateway socket did not work: %w", err)
	}
	for _, path := range []string{os.Getenv(networkBridgeTestDeniedEnv), os.Getenv(networkBridgeTestAliasEnv)} {
		conn, dialErr := net.DialTimeout("unix", path, time.Second)
		if dialErr == nil {
			_ = conn.Close()
			return fmt.Errorf("ungranted socket path %q unexpectedly connected", path)
		}
		if !errors.Is(dialErr, syscall.EACCES) {
			return fmt.Errorf("ungranted socket path %q failed with %v, expected EACCES", path, dialErr)
		}
	}
	if abstractSocket := os.Getenv(networkBridgeTestAbstractEnv); abstractSocket != "" {
		conn, dialErr := net.DialTimeout("unix", abstractSocket, time.Second)
		if dialErr == nil {
			_ = conn.Close()
			return fmt.Errorf("external abstract Unix socket unexpectedly connected")
		}
		if !errors.Is(dialErr, syscall.EPERM) && !errors.Is(dialErr, syscall.EACCES) {
			return fmt.Errorf("external abstract Unix socket failed with %v, expected EPERM or EACCES", dialErr)
		}
	}

	if mode == "allowed-domains" {
		proxyURL, err := url.Parse(os.Getenv("HTTP_PROXY"))
		if err != nil {
			return fmt.Errorf("parse helper proxy URL: %w", err)
		}
		transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
		client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
		response, requestErr := client.Get("http://landlock-test.invalid/relay")
		if requestErr != nil {
			return fmt.Errorf("localhost proxy could not reach the exact allowed Unix proxy socket: %w", requestErr)
		}
		body, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		transport.CloseIdleConnections()
		if readErr != nil || closeErr != nil || response.StatusCode != http.StatusOK || string(body) != "proxy-ok" {
			return fmt.Errorf("fake Unix proxy returned status=%d body=%q readErr=%v closeErr=%v", response.StatusCode, body, readErr, closeErr)
		}
	}

	return exerciseLandlockTestLocalIPCAndRefer()
}

func roundTripLandlockTestSocket(path string) error {
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	if _, err := conn.Write([]byte("ping")); err != nil {
		return err
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if string(reply) != "ping" {
		return fmt.Errorf("unexpected reply %q", reply)
	}
	return nil
}

func exerciseLandlockTestLocalIPCAndRefer() error {
	workDir, err := os.MkdirTemp("", "canvastty-landlock-client-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)

	localSocket := filepath.Join(workDir, "local.sock")
	listener, err := net.Listen("unix", localSocket)
	if err != nil {
		return fmt.Errorf("create same-domain Unix server: %w", err)
	}
	accepted := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			accepted <- acceptErr
			return
		}
		defer conn.Close()
		buf := make([]byte, 4)
		if _, acceptErr = io.ReadFull(conn, buf); acceptErr == nil {
			_, acceptErr = conn.Write(buf)
		}
		accepted <- acceptErr
	}()
	if err := roundTripLandlockTestSocket(localSocket); err != nil {
		_ = listener.Close()
		return fmt.Errorf("connect to same-domain Unix server: %w", err)
	}
	if err := <-accepted; err != nil {
		_ = listener.Close()
		return fmt.Errorf("same-domain Unix server failed: %w", err)
	}
	if err := listener.Close(); err != nil {
		return err
	}

	left, right := filepath.Join(workDir, "left"), filepath.Join(workDir, "right")
	if err := os.Mkdir(left, 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(right, 0o700); err != nil {
		return err
	}
	from := filepath.Join(left, "move-me")
	renamed := filepath.Join(right, "renamed")
	linked := filepath.Join(left, "linked")
	if err := os.WriteFile(from, []byte("refer-ok"), 0o600); err != nil {
		return err
	}
	if err := os.Rename(from, renamed); err != nil {
		return fmt.Errorf("cross-directory rename failed: %w", err)
	}
	if err := os.Link(renamed, linked); err != nil {
		return fmt.Errorf("cross-directory hard link failed: %w", err)
	}
	contents, err := os.ReadFile(linked)
	if err != nil || string(contents) != "refer-ok" {
		return fmt.Errorf("cross-directory rename/link produced contents %q: %v", contents, err)
	}
	return nil
}

func startLandlockTestEcho(t *testing.T, path string) net.Listener {
	t.Helper()
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer conn.Close()
				buf := make([]byte, 4)
				if _, readErr := io.ReadFull(conn, buf); readErr == nil {
					_, _ = conn.Write(buf)
				}
			}()
		}
	}()
	return listener
}

func serveLandlockTestProxy(listener net.Listener, expectedAuth string) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	request, err := http.ReadRequest(bufio.NewReader(conn))
	if err != nil {
		return
	}
	if request.Header.Get("Proxy-Authorization") != expectedAuth {
		_, _ = io.WriteString(conn, "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		return
	}
	_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nproxy-ok")
}

func setLandlockTestEnv(environment []string, key, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(environment)+1)
	for _, item := range environment {
		if !strings.HasPrefix(item, prefix) {
			result = append(result, item)
		}
	}
	return append(result, prefix+value)
}
