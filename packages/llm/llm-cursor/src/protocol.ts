/**
 * Unofficial Cursor auth and agent wire constants. These are protocol facts,
 * not deployment tunables: a changed URL or client version is a Cursor-side
 * change, not a composition setting.
 *
 * @module @deepseek-ai/dsh-llm-cursor/protocol
 */

/** Plugin id, settings namespace, and credential-record scope. */
export const NS = 'llm-cursor'

/** Always-registered provider route this adapter owns. */
export const PROVIDER = 'cursor'

/** `providerIdentifier` this adapter stamps on every MCP tool definition and historical MCP call. */
export const MCP_PROVIDER_IDENTIFIER = 'dsh'

/**
 * Prefix of an MCP tool's name in Cursor's IDE: `mcp_<providerIdentifier>_<toolName>`.
 * A model that echoes it on a call is unwrapped to the harness tool name.
 */
export const MCP_PROMPT_TOOL_PREFIX = `mcp_${MCP_PROVIDER_IDENTIFIER}_`

/** Cursor CLI tool that calls an MCP tool: `{ namespace, toolName, arguments }`. */
export const DYNAMIC_TOOL_CALL = 'CallDynamicTool'

/** Cursor CLI tool that searches MCP tools (`{ pattern }`) or returns one schema (`{ namespace, toolName }`). */
export const DYNAMIC_TOOL_LOOKUP = 'GetDynamicTools'

/** Interval of the `clientHeartbeat` the Cursor CLI sends on an open Run. */
export const CLIENT_HEARTBEAT_INTERVAL_MS = 5_000

/** Default credential reference resolved before a stored grant or harvest. */
export const DEFAULT_API_KEY_ENV = 'CURSOR_ACCESS_TOKEN'

/** Cursor PKCE login page. */
export const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'

/** PKCE poll endpoint. */
export const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll'

/** Refresh-token exchange endpoint. */
export const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key'

/** HTTP/2 origin for `agent.v1` RPCs. */
export const CURSOR_AGENT_URL = 'https://agentn.us.api5.cursor.sh'

/** Client-version header Cursor currently accepts from CLI-shaped clients. */
export const CURSOR_CLIENT_VERSION = 'cli-2026.07.23-e383d2b'

/** Connect RPC path for one rebuilt Run. */
export const CURSOR_RUN_PATH = '/agent.v1.AgentService/Run'

/** Connect RPC path for the account model list. */
export const CURSOR_USABLE_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels'

/** Maximum PKCE poll attempts before the login fails. */
export const POLL_MAX_ATTEMPTS = 150

/** First poll delay in milliseconds. */
export const POLL_BASE_DELAY_MS = 1_000

/** Poll delay ceiling in milliseconds. */
export const POLL_MAX_DELAY_MS = 10_000

/** Multiplier applied after each empty poll. */
export const POLL_BACKOFF_MULTIPLIER = 1.2

/** Per-auth HTTP timeout in milliseconds. */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000

/** Connect EndStream flag (second bit). */
export const CONNECT_END_STREAM = 0b00000010

/** Maximum Connect payload this client will frame or accept. */
export const MAX_CONNECT_MESSAGE_BYTES = 64 * 1024 * 1024

/** Default idle watchdog while one Run read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Refresh this many milliseconds before JWT `exp`. */
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000

/** Fallback lifetime when a token is not a JWT with `exp`. */
export const TOKEN_FALLBACK_TTL_MS = 60 * 60 * 1000

/** Default lifetime of a Run parked on tool calls: thirty minutes. */
export const DEFAULT_PARKED_RUN_TIMEOUT_MS = 30 * 60 * 1000

/** Default wait for further parallel tool calls after one arrives. */
export const DEFAULT_TOOL_CALL_SETTLE_MS = 1_000
