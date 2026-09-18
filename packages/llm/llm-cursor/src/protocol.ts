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
