export const ORCHESTRATION_MCP_SERVER_NAME: string;
export const MAX_ORCHESTRATION_PAYLOAD_BYTES: number;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const ORCHESTRATION_TOOL_DEFINITIONS: readonly McpToolDefinition[];
export const ORCHESTRATION_TOOL_NAMES: readonly string[];
export function isApprovedOrchestrationTool(value: unknown): value is string;
export function validateOrchestrationArguments(toolName: unknown, value: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };
export function canonicalStringify(value: unknown): string;
