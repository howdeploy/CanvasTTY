package main

// `canvastty-helper hook <state> <event>`: src/agent-runtime/hook-helper.mjs with runtime-client.mjs reportLifecycle.
// A provider's lifecycle hook runs it with the hook input on stdin; it reports the state change to the gateway and
// always exits 0 with nothing on stdout.

import (
	"io"
	"math"
	"os"
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
	turnID := firstString(field(input, "turn_id"), field(input, "turnId"), field(input, "prompt_id"), field(input, "promptId"))
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
	reportLifecycle(state, event, turnID, threadID, result, lastAssistantMessage)
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

func reportLifecycle(state, event string, turnID, threadID any, result *jsObject, lastAssistantMessage *string) bool {
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
	expiresAt := envNumber(envCaptureAnswerExpiresAt)
	shouldCheck := envEquals(envCaptureAnswer, "1") && isFinite(expiresAt) && expiresAt > nowMs() &&
		provider == "codex" && event == "Stop" && state == "idle" && lastAssistantMessage != nil
	if shouldCheck && answerCaptureIsActive(address, terminalSessionID, provider, capability) {
		message.set("lastAssistantMessage", jsSlice(*lastAssistantMessage, maxAnswerChars))
	}
	payload := append([]byte(jsonStringify(message)), '\n')
	maxBytes := maxRuntimeMessageBytes
	if result != nil {
		maxBytes = maxResultMessageBytes
	}
	if len(payload) > maxBytes {
		return false
	}
	return sendRuntimeMessage(address, payload, func(reply any) bool {
		return field(reply, "type") == "ack"
	})
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
	if len(payload) > maxResultMessageBytes {
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
