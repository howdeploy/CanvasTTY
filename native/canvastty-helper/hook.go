package main

// `canvastty-helper hook <state> <event>`: src/agent-runtime/hook-helper.mjs with runtime-client.mjs reportLifecycle.
// A provider's lifecycle hook runs it with the hook input on stdin; it reports the state change to the gateway and
// always exits 0 with nothing on stdout.

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"math"
	"os"
	"strings"
	"time"
)

func nan() float64 { return math.NaN() }

func runHook(args []string) int {
	if len(args) < 2 || !isRuntimeState(args[0]) || args[1] == "" {
		return 0
	}
	state := decodeUTF8([]byte(args[0]))
	event := decodeUTF8([]byte(args[1]))

	captureResult := envEquals(envCaptureResult, "1")
	expiresAt := envNumber(envCaptureAnswerExpiresAt)
	captureAnswer := envEquals(envCaptureAnswer, "1") && isFinite(expiresAt) && expiresAt > nowMs()

	raw := readHookInput()
	var input any = undefinedValue{}
	if raw != nil {
		if parsed, err := jsonParse(raw); err == nil {
			input = parsed
		}
	}
	provider, _ := env(envRuntimeProvider)
	var providerTurn any = undefinedValue{}
	if provider == "hermes" {
		providerTurn = field(field(input, "extra"), "turn_id")
	}
	turnID := firstString(field(input, "turn_id"), field(input, "turnId"), field(input, "prompt_id"), field(input, "promptId"), providerTurn)
	threadID := firstString(field(input, "session_id"), field(input, "sessionId"), field(input, "thread_id"),
		field(input, "threadId"), field(input, "conversation_id"), field(input, "conversationId"))
	var finalAnswer *string
	if state == "idle" && event == "Stop" {
		if text, ok := field(input, "last_assistant_message").(string); ok {
			finalAnswer = &text
		}
	}
	var result *jsObject
	if captureResult && finalAnswer != nil {
		text := boundedText(*finalAnswer, maxResultChars)
		result = obj("text", text, "truncated", jsLength(text) < jsLength(*finalAnswer))
	}
	var lastAssistantMessage *string
	if captureAnswer && finalAnswer != nil {
		text := boundedText(*finalAnswer, maxAnswerChars)
		lastAssistantMessage = &text
	}
	toolOutcome := nativeToolOutcome(provider, event, input)
	reportLifecycle(state, event, turnID, threadID, result, lastAssistantMessage, toolOutcome)
	return 0
}

// readHookInput reads stdin whole; nil (no input) when its UTF-8 decoding is over MAX_HOOK_INPUT_BYTES.
func readHookInput() []byte {
	raw, over := readStdinBounded(maxHookInputBytes)
	// The decoded text is never shorter than the bytes, and it is what the JS helper measures.
	if over || decodedLength(raw) > maxHookInputBytes {
		return nil
	}
	return raw
}

func envEquals(key, value string) bool {
	actual, ok := env(key)
	return ok && actual == value
}

func isFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// firstString is the first non-empty string, or null.
func firstString(values ...any) any {
	for _, value := range values {
		if text, ok := value.(string); ok && text != "" {
			return text
		}
	}
	return nil
}

func reportLifecycle(state, event string, turnID, threadID any, result *jsObject, lastAssistantMessage *string, toolOutcome *jsObject) bool {
	if !isRuntimeState(state) || event == "" || jsLength(event) > 80 {
		return false
	}
	address, _ := env(envRuntimeAddress)
	terminalSessionID, _ := env(envRuntimeTerminalSessionID)
	provider, _ := env(envRuntimeProvider)
	capability, _ := env(envRuntimeCapability)
	if address == "" || terminalSessionID == "" || provider == "" || capability == "" {
		return false
	}
	var normalizedTurn any
	if text, ok := turnID.(string); ok && text != "" && jsLength(text) <= 160 {
		normalizedTurn = text
	}
	message := obj(
		"v", float64(runtimeProtocolVersion),
		"type", "lifecycle",
		"terminalSessionId", terminalSessionID,
		"provider", provider,
		"capabilityToken", capability,
		"state", state,
		"event", event,
		"turnId", normalizedTurn,
	)
	if thread, ok := normalizeThreadID(provider, threadID); ok {
		message.set("threadId", thread)
	}
	if result != nil {
		message.set("result", result)
	}
	if toolOutcome != nil {
		message.set("toolOutcome", toolOutcome)
	}
	expiresAt := envNumber(envCaptureAnswerExpiresAt)
	shouldCheck := envEquals(envCaptureAnswer, "1") && isFinite(expiresAt) && expiresAt > nowMs() &&
		provider == "codex" && event == "Stop" && state == "idle" && lastAssistantMessage != nil
	if shouldCheck && answerCaptureIsActive(address, terminalSessionID, provider, capability) {
		message.set("lastAssistantMessage", jsSlice(*lastAssistantMessage, maxAnswerChars))
	}
	payload := append([]byte(jsonStringify(message)), '\n')
	if len(payload) > maxRuntimeMessageBytes {
		return false
	}
	return sendRuntimeMessage(address, payload, func(reply any) bool {
		return field(reply, "type") == "ack"
	})
}

func nativeToolOutcome(provider, event string, input any) *jsObject {
	if event != "PostToolUse" && !((provider == "claude" || provider == "kimi") && event == "PostToolUseFailure") && !(provider == "hermes" && event == "post_tool_call") {
		return nil
	}
	rawToolName, _ := field(input, "tool_name").(string)
	toolName := boundedText(stripToolNameControls(strings.TrimSpace(rawToolName)), 80)
	if toolName == "" {
		toolName = "unknown"
	}
	response := field(input, "tool_response")
	legacyResponse := !isUndefined(response)
	var extra any = undefinedValue{}
	if provider == "hermes" && isPlainObject(field(input, "extra")) {
		extra = field(input, "extra")
	}
	if !legacyResponse {
		if provider == "kimi" {
			if output, ok := field(input, "tool_output").(string); ok {
				response = output
			}
		} else if provider == "hermes" {
			response = field(extra, "result")
		}
	}
	resultClass := "unknown"
	if provider == "claude" && event == "PostToolUse" {
		resultClass = "success"
	} else if provider == "claude" && event == "PostToolUseFailure" {
		if field(input, "is_interrupt") != true {
			resultClass = "error"
		}
	} else if provider == "kimi" && event == "PostToolUseFailure" {
		resultClass = "error"
	} else if status, ok := field(extra, "status").(string); provider == "hermes" && !legacyResponse && ok {
		switch status {
		case "ok":
			resultClass = "success"
		case "blocked":
			resultClass = "denied"
		case "error", "timeout":
			resultClass = "error"
		}
	} else {
		resultClass = explicitNativeToolResultClass(response)
	}
	outcome := obj("toolName", toolName, "resultClass", resultClass)
	toolInput := field(input, "tool_input")
	if !isUndefined(toolInput) {
		action := strings.ToLower(toolName) + "\n" + jsonStringify(toolInput)
		outcome.set("normalizedActionHash", hashToolOutcome(action))
	}
	errorText := firstToolOutcomeString(field(input, "error"), field(input, "tool_error"), field(input, "toolError"),
		field(response, "error"), field(response, "tool_error"), field(extra, "error_message"))
	if resultClass == "error" && errorText != "" {
		outcome.set("errorHash", hashToolOutcome(normalizeToolOutcomeText(boundedText(errorText, 8192))))
	}
	// Parity with runtime-protocol.mjs: a hash of the tool's output for non-error results; the text never leaves.
	if resultClass != "error" && !isUndefined(response) && response != nil {
		text, ok := response.(string)
		if !ok {
			text = jsonStringify(response)
		}
		outcome.set("outputHash", hashToolOutcome(normalizeToolOutcomeText(boundedText(text, 16384))))
	}
	paths := []any{}
	if resultClass == "success" && (strings.EqualFold(strings.TrimSpace(rawToolName), "Edit") || strings.EqualFold(strings.TrimSpace(rawToolName), "Write")) {
		if path, ok := field(response, "filePath").(string); ok {
			path = strings.ReplaceAll(strings.TrimSpace(path), "\\", "/")
			if path != "" {
				paths = append(paths, hashToolOutcome(path))
			}
		}
	}
	outcome.set("changedPathHashes", paths)
	return outcome
}

func explicitNativeToolResultClass(response any) string {
	if !isPlainObject(response) {
		return "unknown"
	}
	if field(response, "denied") == true || field(response, "status") == "denied" || field(response, "resultClass") == "denied" {
		return "denied"
	}
	if field(response, "isError") == true || field(response, "is_error") == true || field(response, "success") == false ||
		field(response, "status") == "error" || field(response, "status") == "failed" || field(response, "resultClass") == "error" {
		return "error"
	}
	if field(response, "success") == true || field(response, "status") == "success" || field(response, "status") == "completed" || field(response, "resultClass") == "success" {
		return "success"
	}
	exitCode := field(response, "exit_code")
	if isUndefined(exitCode) {
		exitCode = field(response, "exitCode")
	}
	if code, ok := exitCode.(float64); ok && !math.IsNaN(code) && !math.IsInf(code, 0) && math.Trunc(code) == code {
		if code == 0 {
			return "success"
		}
		return "error"
	}
	return "unknown"
}

func firstToolOutcomeString(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok && text != "" {
			return text
		}
	}
	return ""
}

func stripToolNameControls(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func normalizeToolOutcomeText(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"))
}

func hashToolOutcome(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func answerCaptureIsActive(address, terminalSessionID, provider, capability string) bool {
	request := obj(
		"v", float64(runtimeProtocolVersion),
		"type", "answer-capture-check",
		"terminalSessionId", terminalSessionID,
		"provider", provider,
		"capabilityToken", capability,
	)
	return sendRuntimeMessage(address, append([]byte(jsonStringify(request)), '\n'), func(reply any) bool {
		return field(reply, "type") == "ack" && field(reply, "answerCapture") == true
	})
}

func sendRuntimeMessage(address string, payload []byte, accepted func(any) bool) bool {
	if len(payload) > maxRuntimeMessageBytes {
		return false
	}
	line, ok := exchangeLine(address, payload, runtimeConnectTimeoutMs*time.Millisecond)
	if !ok {
		return false
	}
	reply, err := jsonParse(line)
	if err != nil {
		return false
	}
	return field(reply, "v") == float64(runtimeProtocolVersion) && accepted(reply)
}

// readStdinBounded reads stdin to its end; over is true (and reading stops) once more than limit bytes arrived.
func readStdinBounded(limit int) (raw []byte, over bool) {
	buffer := make([]byte, 64*1024)
	for {
		n, err := os.Stdin.Read(buffer)
		raw = append(raw, buffer[:n]...)
		if len(raw) > limit {
			return nil, true
		}
		if err != nil {
			if err == io.EOF {
				return raw, false
			}
			return raw, false
		}
	}
}
