package main

// `canvastty-helper mcp-orchestration`: src/agent-browser/orchestration-helper.mjs, the canvastty_agents stdio MCP
// server of orchestrators (and of sessions a plugin tool applies to). It authenticates to the OrchestrationGateway
// with the card's capability and connection id and forwards tool calls; after a dropped connection it reconnects with
// the rotated token.

import (
	"math"
	"sync"
	"time"
)

const maxOrchestrationPayloadBytes = 128 * 1024

// Before the first authentication the gateway may still be starting (or restarting): a call tries this many
// connections, spaced orchestrationConnectRetry apart, before it fails; the next call starts over.
const (
	orchestrationConnectAttempts = 3
	orchestrationConnectRetry    = 250 * time.Millisecond
	// A call the gateway never answers fails instead of waiting forever: bounded waits after their own timeout and a
	// margin, every other call after three minutes.
	orchestrationCallTimeout = 180 * time.Second
	orchestrationWaitMargin  = 30 * time.Second
)

// orchestrationPending is one call: registered before connecting, so a cancellation or a timeout while it connects
// ends it too.
type orchestrationPending struct {
	result *future
	sent   bool
	timer  *time.Timer
}

// orchestrationError is orchestration-helper.mjs BridgeError: the gateway's error payload as is.
type orchestrationError struct {
	payload any
	message string
}

func (e *orchestrationError) Error() string { return e.message }

func newOrchestrationError(payload any) *orchestrationError {
	message, _ := field(payload, "message").(string)
	return &orchestrationError{payload: payload, message: message}
}

func orchestrationTimedOut() *orchestrationError {
	return newOrchestrationError(obj("code", "TIMEOUT", "message", "Orchestration command timed out.", "retryable", true))
}

func orchestrationCanceled() *orchestrationError {
	return newOrchestrationError(obj("code", "CANCELED", "message", "Orchestration command was canceled by the MCP client.", "retryable", true))
}

func orchestrationUnavailable() *orchestrationError {
	return newOrchestrationError(obj(
		"code", "BRIDGE_UNAVAILABLE",
		"message", "CanvasTTY orchestration bridge is unavailable.",
		"retryable", true,
	))
}

type orchestrationIdentity struct {
	address, terminalSessionID, connectionID string
	capabilityToken                          any
}

type orchestrationClient struct {
	mu                 sync.Mutex
	identity           orchestrationIdentity
	connectTimeout     time.Duration
	socket             *asyncSocket
	lines              *lineReader
	pending            map[string]*orchestrationPending
	callTimeout        time.Duration
	authenticated      *future
	authenticatedState bool
	heartbeats         []*time.Timer
	heartbeatID        int
	closed             bool
	reconnectToken     any
	connectAttempts    int
}

func newOrchestrationClient(identity orchestrationIdentity) *orchestrationClient {
	return &orchestrationClient{
		identity:       identity,
		connectTimeout: 10 * time.Second,
		lines:          newLineReader(maxOrchestrationPayloadBytes, func() bool { return false }),
		pending:        map[string]*orchestrationPending{},
	}
}

func (c *orchestrationClient) connect() *future {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return rejectedFuture(orchestrationUnavailable())
	}
	if c.authenticated != nil {
		return c.authenticated
	}
	c.connectAttempts = 0
	c.authenticated = newFuture()
	c.openConnection()
	return c.authenticated
}

func (c *orchestrationClient) openConnection() {
	if c.closed || c.socket != nil {
		return
	}
	var socket *asyncSocket
	timeout := &guardedTimer{}
	onConnect := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		timeout.stop()
		text, _ := canonicalStringify(obj(
			"v", float64(browserProtocolVersion),
			"type", "authenticate",
			"connectionId", c.identity.connectionID,
			"terminalSessionId", c.identity.terminalSessionID,
			"capabilityToken", c.identity.capabilityToken,
		))
		socket.write([]byte(text + "\n"))
	}
	onData := func(chunk []byte) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.handleData(socket, chunk)
	}
	onEnd := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.handleDisconnect(socket, orchestrationUnavailable())
	}
	socket = openSocket(c.identity.address, onConnect, onData, onEnd)
	c.socket = socket
	c.lines = newLineReader(maxOrchestrationPayloadBytes, func() bool { return false })
	timeout.start(&c.mu, c.connectTimeout, func() { c.handleDisconnect(socket, orchestrationUnavailable()) })
}

func (c *orchestrationClient) handleData(socket *asyncSocket, chunk []byte) {
	if socket != c.socket {
		return
	}
	lines, ok := c.lines.push(chunk)
	if !ok {
		// The gateway never sends a line over the limit: this peer is broken.
		c.handleDisconnect(socket, orchestrationUnavailable())
		return
	}
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}
		message, err := jsonParse(line)
		if err != nil {
			continue
		}
		c.handleMessage(socket, message)
	}
}

func (c *orchestrationClient) handleMessage(socket *asyncSocket, message any) {
	if message == nil {
		// `message.type` on null throws in the socket's data handler: the JS helper dies.
		crash()
	}
	switch field(message, "type") {
	case "authenticated":
		token := field(message, "reconnectToken")
		if token == nil || isUndefined(token) {
			token = nil
		}
		c.reconnectToken = token
		c.authenticatedState = true
		interval := field(message, "heartbeatIntervalMs")
		if interval == nil || isUndefined(interval) {
			interval = 5_000.0
		}
		c.startHeartbeat(socket, nodeTimerDelay(interval))
		if c.authenticated != nil {
			c.authenticated.resolve(nil)
		}
	case "response":
		id, _ := field(message, "id").(string)
		pending, ok := c.pending[id]
		if !ok {
			return
		}
		delete(c.pending, id)
		pending.timer.Stop()
		if errorPayload := field(message, "error"); truthy(errorPayload) {
			pending.result.reject(newOrchestrationError(errorPayload))
		} else {
			result := field(message, "result")
			if result == nil || isUndefined(result) {
				result = newObject()
			}
			pending.result.resolve(result)
		}
	}
}

// nodeTimerDelay is how setInterval reads its delay: a number (or numeric text) from 1 to 2^31-1 ms, else 1 ms.
func nodeTimerDelay(value any) time.Duration {
	var delay float64
	switch v := value.(type) {
	case float64:
		delay = v
	case string:
		delay = jsToNumber(v)
	case bool:
		if v {
			delay = 1
		}
	default:
		delay = nan()
	}
	if !(delay >= 1 && delay <= 2147483647) {
		delay = 1
	}
	return time.Duration(delay * float64(time.Millisecond))
}

// startHeartbeat adds an interval; like the JS helper, a second "authenticated" adds a second one.
func (c *orchestrationClient) startHeartbeat(socket *asyncSocket, interval time.Duration) {
	id := c.heartbeatID
	var timer *time.Timer
	var tick func()
	tick = func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.heartbeatID != id {
			return
		}
		if c.socket == socket && !c.closed {
			text, _ := canonicalStringify(obj("v", float64(browserProtocolVersion), "type", "heartbeat", "timestamp", float64(time.Now().UnixMilli())))
			socket.write([]byte(text + "\n"))
		}
		timer.Reset(interval)
	}
	timer = time.AfterFunc(interval, tick)
	c.heartbeats = append(c.heartbeats, timer)
}

func (c *orchestrationClient) stopHeartbeats() {
	for _, timer := range c.heartbeats {
		timer.Stop()
	}
	c.heartbeats = nil
	c.heartbeatID++
}

func (c *orchestrationClient) handleDisconnect(socket *asyncSocket, err error) {
	if socket != c.socket || c.closed {
		return
	}
	c.socket = nil
	c.stopHeartbeats()
	// What the gateway had is lost with the connection; a call still waiting to be sent waits for the next one.
	for id, pending := range c.pending {
		if pending.sent {
			c.settle(id, pending, err, false)
		}
	}
	if !c.authenticatedState {
		c.failAuthentication(err)
		return
	}
	// The bootstrap token is consumed; the rotated reconnect token keeps this helper usable after a socket drop.
	if truthy(c.reconnectToken) {
		c.identity.capabilityToken = c.reconnectToken
		time.AfterFunc(200*time.Millisecond, func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			if !c.closed && c.socket == nil {
				c.openConnection()
			}
		})
	}
}

// failAuthentication is a connection lost before the first authentication: retried a few times, then the waiting
// calls fail and the next call connects again instead of failing for the rest of the session. c.mu is held.
func (c *orchestrationClient) failAuthentication(err error) {
	c.connectAttempts++
	if !c.closed && c.connectAttempts < orchestrationConnectAttempts {
		time.AfterFunc(orchestrationConnectRetry, func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			if c.closed {
				c.failAuthentication(err)
			} else if c.socket == nil {
				c.openConnection()
			}
		})
		return
	}
	authenticated := c.authenticated
	c.authenticated = nil
	if authenticated != nil {
		authenticated.reject(err)
	}
}

func (c *orchestrationClient) request(message *jsObject, id string, timeout time.Duration) (any, error) {
	pending := &orchestrationPending{result: newFuture()}
	c.mu.Lock()
	c.pending[id] = pending
	pending.timer = time.AfterFunc(timeout, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.settle(id, pending, orchestrationTimedOut(), true)
	})
	c.mu.Unlock()
	_, err := c.connect().wait()
	c.mu.Lock()
	switch {
	case c.pending[id] != pending:
	case err != nil:
		c.settle(id, pending, err, false)
	case c.socket == nil:
		c.settle(id, pending, orchestrationUnavailable(), false)
	default:
		full := obj("v", float64(browserProtocolVersion))
		for _, key := range message.keys {
			full.set(key, message.values[key])
		}
		if text, stringifyErr := canonicalStringify(full); stringifyErr != nil {
			c.settle(id, pending, &internalError{message: stringifyErr.Error()}, false)
		} else {
			pending.sent = true
			c.socket.write([]byte(text + "\n"))
		}
	}
	c.mu.Unlock()
	return pending.result.wait()
}

// cancel is the MCP client cancelling a call: it ends here and at the gateway.
func (c *orchestrationClient) cancel(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if pending, ok := c.pending[id]; ok {
		c.settle(id, pending, orchestrationCanceled(), true)
	}
}

// settle ends one call with err; with stopGateway, a call the gateway already has is cancelled there. c.mu is held.
func (c *orchestrationClient) settle(id string, pending *orchestrationPending, err error, stopGateway bool) {
	if c.pending[id] != pending {
		return
	}
	delete(c.pending, id)
	pending.timer.Stop()
	if stopGateway && pending.sent && c.socket != nil && !c.closed {
		text, _ := canonicalStringify(obj("v", float64(browserProtocolVersion), "type", "cancel", "id", id))
		c.socket.write([]byte(text + "\n"))
	}
	pending.result.reject(err)
}

func (c *orchestrationClient) timeoutFor(tool string, args any) time.Duration {
	if c.callTimeout > 0 {
		return c.callTimeout
	}
	if tool != "wait_for_agent" && tool != "ask_user" {
		return orchestrationCallTimeout
	}
	seconds := float64(catalogInt("orchestration", "defaultAgentWaitSeconds"))
	if value, ok := field(args, "timeoutSeconds").(float64); ok && value == math.Trunc(value) && !math.IsInf(value, 0) {
		seconds = value
	}
	return time.Duration(seconds*float64(time.Second)) + orchestrationWaitMargin
}

func (c *orchestrationClient) call(tool string, args any, id string) (any, error) {
	return c.request(obj("type", "request", "id", id, "tool", tool, "arguments", args), id, c.timeoutFor(tool, args))
}

func (c *orchestrationClient) listTools() (any, error) {
	id := "helper-" + randomUUID()
	result, err := c.request(obj("type", "list_tools", "id", id), id, c.timeoutFor("", nil))
	if err != nil {
		return nil, err
	}
	if tools, ok := field(result, "tools").([]any); ok {
		return tools, nil
	}
	return []any{}, nil
}

func (c *orchestrationClient) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.stopHeartbeats()
	if c.socket != nil {
		c.socket.destroy()
	}
	c.socket = nil
	for id, pending := range c.pending {
		c.settle(id, pending, orchestrationUnavailable(), false)
	}
}

func orchestrationErrorResponse(id any, err error) *jsObject {
	code := -32603
	message := "Internal error"
	switch e := err.(type) {
	case *rpcError:
		code = e.code
		message = e.message
	case *orchestrationError:
		message = e.message
	case *internalError:
		message = e.message
	}
	return obj("jsonrpc", "2.0", "id", idOrNull(id), "error", obj("code", float64(code), "message", message))
}

func orchestrationFailure(payload any) *jsObject {
	text, _ := canonicalStringify(obj("ok", false, "error", payload))
	return obj("content", []any{obj("type", "text", "text", text)}, "isError", true)
}

func orchestrationDispatcher(client *orchestrationClient) func(any) (*jsObject, error) {
	// MCP request id (canonical JSON) -> the bridge id of its call, so a cancellation reaches the gateway.
	var activeMu sync.Mutex
	active := map[string]string{}
	requestKey := func(value any) (string, bool) {
		key, err := mcpRequestKey(value)
		if err != nil || key == nil {
			return "", false
		}
		return key.(string), true
	}
	return func(request any) (*jsObject, error) {
		if err := requestShapeError(request); err != nil {
			return nil, err
		}
		id := field(request, "id")
		switch field(request, "method") {
		case "notifications/initialized":
			return nil, nil
		case "notifications/cancelled":
			if key, ok := requestKey(field(field(request, "params"), "requestId")); ok {
				activeMu.Lock()
				bridgeID := active[key]
				activeMu.Unlock()
				if bridgeID != "" {
					client.cancel(bridgeID)
				}
			}
			return nil, nil
		case "ping":
			return response(id, newObject()), nil
		case "initialize":
			if _, err := client.connect().wait(); err != nil {
				return nil, err
			}
			return response(id, obj(
				"protocolVersion", defaultMCPProtocolVersion,
				"capabilities", obj("tools", obj("listChanged", false)),
				"serverInfo", obj("name", catalogString("orchestration", "serverName"), "version", "1.0.0"),
				"instructions", catalogString("orchestration", "instructions"),
			)), nil
		case "tools/list":
			// The host lists what this session sees; if it cannot answer, the core tools are listed as before.
			tools, err := client.listTools()
			if err != nil {
				tools = catalogValue("orchestration", "tools")
			}
			return response(id, obj("tools", tools)), nil
		case "tools/call":
			if isUndefined(id) {
				return nil, &rpcError{code: -32600, message: "Tool calls require a request id"}
			}
			params := field(request, "params")
			name, isString := field(params, "name").(string)
			if !truthy(params) || !isObjectLike(params) || !isString {
				return nil, &rpcError{code: -32602, message: "Invalid tool parameters"}
			}
			args := field(params, "arguments")
			if args == nil || isUndefined(args) {
				args = newObject()
			}
			// A malformed core call gets its reason here; the bridge would drop the whole connection over it.
			if coreOrchestrationTool(name) {
				if message, ok := validateOrchestrationArguments(name, args); !ok {
					return response(id, orchestrationFailure(obj("code", "INVALID_REQUEST", "message", message, "retryable", false))), nil
				}
			}
			key, keyed := requestKey(id)
			bridgeID := "helper-" + randomUUID()
			if keyed {
				activeMu.Lock()
				active[key] = bridgeID
				activeMu.Unlock()
				defer func() {
					activeMu.Lock()
					if active[key] == bridgeID {
						delete(active, key)
					}
					activeMu.Unlock()
				}()
			}
			result, err := client.call(name, args, bridgeID)
			if err == nil {
				if text, ok := field(result, "text").(string); ok && isPluginOrchestrationTool(name) {
					return response(id, obj("content", []any{obj("type", "text", "text", text)}, "isError", field(result, "isError") == true)), nil
				}
				if text, stringifyErr := canonicalStringify(result); stringifyErr == nil {
					return response(id, obj("content", []any{obj("type", "text", "text", text)}, "isError", false)), nil
				}
				err = &internalError{message: "Canonical JSON cannot contain a non-finite number."}
			}
			if bridge, ok := err.(*orchestrationError); ok {
				return response(id, orchestrationFailure(bridge.payload)), nil
			}
			return response(id, orchestrationFailure(orchestrationUnavailable().payload)), nil
		}
		if isUndefined(id) {
			return nil, nil
		}
		return nil, &rpcError{code: -32601, message: "Method not found"}
	}
}

func runOrchestrationMCP() int {
	keys := []string{
		"CANVASTTY_ORCHESTRATION_ADDRESS",
		"CANVASTTY_ORCHESTRATION_CAPABILITY",
		"CANVASTTY_TERMINAL_SESSION_ID",
		"CANVASTTY_ORCHESTRATION_CONNECTION_ID",
	}
	values := make([]string, len(keys))
	for i, key := range keys {
		value, ok := env(key)
		if !ok || value == "" || jsLength(value) > 8_192 {
			return 1
		}
		values[i] = value
	}
	client := newOrchestrationClient(orchestrationIdentity{
		address: values[0], capabilityToken: values[1], terminalSessionID: values[2], connectionID: values[3],
	})
	// Replaces every call's timeout (tests).
	if timeout := envNumber("CANVASTTY_ORCHESTRATION_CALL_TIMEOUT_MS"); timeout == math.Trunc(timeout) && timeout >= 1 && timeout <= 600_000 {
		client.callTimeout = time.Duration(timeout * float64(time.Millisecond))
	}
	server := &mcpServer{
		maxBytes:      maxOrchestrationPayloadBytes,
		requestLimit:  "Request exceeds 128KB",
		responseLimit: "Response exceeds 128KB",
		errorResponse: orchestrationErrorResponse,
		dispatch:      orchestrationDispatcher(client),
		blocking:      map[string]bool{"initialize": true, "tools/call": true, "tools/list": true},
		close:         client.close,
	}
	return server.run()
}
