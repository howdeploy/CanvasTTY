package main

// The agent-runtime protocol (src/agent-runtime/runtime-protocol.mjs, runtime-client.mjs): lifecycle hooks and the
// decision hook talk to CanvasTTY's RuntimeGateway over its capability-authenticated socket, one line each way.

import (
	"io"
	"os"
	"strconv"
	"time"
)

const (
	runtimeProtocolVersion = 1
	maxRuntimeMessageBytes = 64 * 1024
	maxResultMessageBytes  = 512 * 1024
	maxHookInputBytes      = 512 * 1024
	maxResultChars         = 65_536
	maxAnswerChars         = 4000

	envRuntimeAddress           = "CANVASTTY_RUNTIME_ADDRESS"
	envRuntimeTerminalSessionID = "CANVASTTY_RUNTIME_TERMINAL_SESSION_ID"
	envRuntimeProvider          = "CANVASTTY_RUNTIME_PROVIDER"
	envRuntimeCapability        = "CANVASTTY_RUNTIME_CAPABILITY"
	envCaptureResult            = "CANVASTTY_RUNTIME_CAPTURE_RESULT"
	envCaptureAnswer            = "CANVASTTY_RUNTIME_CAPTURE_ANSWER"
	envCaptureAnswerExpiresAt   = "CANVASTTY_RUNTIME_CAPTURE_ANSWER_EXPIRES_AT"
	envDecisionBudget           = "CANVASTTY_RUNTIME_DECISION_MS"
	envDecisionFailClosed       = "CANVASTTY_RUNTIME_FAIL_CLOSED"

	// PERMISSION_GATE in runtime-protocol.mjs.
	gateHelperMs            = 12_000
	gateGatewayMs           = 10_000
	gateToolInputBytes      = 40 * 1024
	gateToolInputPreview    = 8 * 1024
	gateToolNameChars       = 200
	gateMessageChars        = 1_000
	defaultDecideTimeoutMs  = 3_000
	maxDecideTimeoutMs      = 60_000
	runtimeConnectTimeoutMs = 1_000
)

var runtimeStates = []string{"idle", "working", "needs_approval"}

func isRuntimeState(value string) bool {
	for _, state := range runtimeStates {
		if state == value {
			return true
		}
	}
	return false
}

// env is process.env[key]: absent is ok=false; values decode as UTF-8 the way Node does.
func env(key string) (string, bool) {
	value, ok := os.LookupEnv(key)
	if !ok {
		return "", false
	}
	return decodeUTF8([]byte(value)), true
}

// envNumber is Number(process.env[key]); an absent variable is NaN.
func envNumber(key string) float64 {
	value, ok := env(key)
	if !ok {
		return nan()
	}
	return jsToNumber(value)
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// normalizeThreadId keeps a provider's conversation id only in a shape that provider issues.
func normalizeThreadID(provider string, value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	switch provider {
	case "codex", "claude":
		if isCanonicalUUID(text) {
			return toLowerASCII(text), true
		}
	case "opencode":
		if len(text) >= 5 && len(text) <= 124 && text[:4] == "ses_" && isAlnum(text[4:]) {
			return text, true
		}
	}
	return "", false
}

func isCanonicalUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < 36; i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func isAlnum(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return s != ""
}

func toLowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// helperDeadline is helperDeadlineMs(process.env): the launch's decision budget, or the default.
func helperDeadline() time.Duration {
	budget := defaultDecideTimeoutMs
	if raw, ok := env(envDecisionBudget); ok && len(raw) >= 1 && len(raw) <= 6 && allDigits(raw) {
		value, _ := strconv.Atoi(raw)
		budget = value
		if budget > maxDecideTimeoutMs {
			budget = maxDecideTimeoutMs
		}
		if budget < defaultDecideTimeoutMs {
			budget = defaultDecideTimeoutMs
		}
	}
	gateway := gateGatewayMs
	if budget+2_000 > gateway {
		gateway = budget + 2_000
	}
	return time.Duration(gateway+(gateHelperMs-gateGatewayMs)) * time.Millisecond
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// exchangeLine sends one line and returns the first line the gateway answers with; ok is false on anything else
// (no socket, refused, closed, an oversized line, the deadline), as runtime-client.mjs and permission-gate.mjs do.
func exchangeLine(address string, payload []byte, deadline time.Duration) ([]byte, bool) {
	type outcome struct {
		line []byte
		ok   bool
	}
	results := make(chan outcome, 1)
	conns := make(chan io.Closer, 1)
	go func() {
		conn, err := dialEndpoint(address)
		if err != nil {
			results <- outcome{}
			return
		}
		conns <- conn
		if _, err := conn.Write(payload); err != nil {
			results <- outcome{}
			return
		}
		lines := newLineReader(maxRuntimeMessageBytes, func() bool { return false })
		buffer := make([]byte, 64*1024)
		for {
			n, err := conn.Read(buffer)
			if n > 0 {
				got, ok := lines.push(buffer[:n])
				if !ok {
					results <- outcome{}
					return
				}
				if len(got) > 0 {
					results <- outcome{line: got[0], ok: true}
					return
				}
			}
			if err != nil {
				results <- outcome{}
				return
			}
		}
	}()
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	var result outcome
	select {
	case result = <-results:
	case <-timer.C:
	}
	select {
	case conn := <-conns:
		conn.Close()
	default:
	}
	return result.line, result.ok
}
