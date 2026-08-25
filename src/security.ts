/**
 * Security Utilities
 *
 * Shared security functions for input validation, error sanitization,
 * and rate limiting.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { McpErrorFactory } from './errors.js';

// Input validation limits
const MAX_STRING_LENGTH = 10000;
// A remote ability may explicitly permit a larger payload, but it may not
// remove the connector's process-level memory guard. This accommodates encoded
// plugin packages while keeping a hostile or malformed schema bounded.
const MAX_SCHEMA_STRING_LENGTH = 100 * 1024 * 1024;
const MAX_ARRAY_ELEMENTS = 1000;
const MAX_OBJECT_DEPTH = 5;

type InputSchema = Record<string, unknown>;

function asSchema(value: unknown): InputSchema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as InputSchema)
    : undefined;
}

function propertySchema(schema: InputSchema | undefined, key: string): InputSchema | undefined {
  const properties = asSchema(schema?.properties);
  return asSchema(properties?.[key]);
}

function arrayItemSchema(schema: InputSchema | undefined, index: number): InputSchema | undefined {
  if (Array.isArray(schema?.prefixItems)) {
    const prefixSchema = asSchema(schema.prefixItems[index]);
    if (prefixSchema) return prefixSchema;
  }
  return asSchema(schema?.items);
}

function stringLimit(schema: InputSchema | undefined): number {
  const declared = schema?.maxLength;
  if (typeof declared !== 'number' || !Number.isSafeInteger(declared) || declared < 0) {
    return MAX_STRING_LENGTH;
  }
  return Math.min(declared, MAX_SCHEMA_STRING_LENGTH);
}

function schemaType(schema: InputSchema | undefined): string | undefined {
  return typeof schema?.type === 'string' ? schema.type : undefined;
}

function shouldValidateSingularId(key: string, schema: InputSchema | undefined): boolean {
  const type = schemaType(schema);
  if (type !== undefined) return type === 'integer';
  return key.endsWith('_id');
}

function shouldValidatePluralIds(key: string, schema: InputSchema | undefined): boolean {
  const type = schemaType(schema);
  if (type !== undefined) {
    return type === 'array' && schemaType(asSchema(schema?.items)) === 'integer';
  }
  return key.endsWith('_ids');
}

function assertDepth(depth: number): void {
  if (depth > MAX_OBJECT_DEPTH) {
    throw McpErrorFactory.invalidParams(
      `Input exceeds maximum nesting depth (${MAX_OBJECT_DEPTH})`,
      { maxDepth: MAX_OBJECT_DEPTH }
    );
  }
}

// Upper bound on the string sanitizeError runs its regexes over. Error bodies
// forwarded here are untrusted and can be up to MAX_ERROR_BODY_BYTES (64KB);
// capping the working string first keeps every replace() linear-bounded and
// prevents a hostile body from stalling the event loop. It is a generous
// multiple of the final 500-char output cap, so redaction of any realistic
// message is byte-identical — only pathological, far-oversized bodies are
// clipped, and clipping can only remove content, never expose a secret.
const MAX_SANITIZE_INPUT_LENGTH = 2000;

/**
 * Validate input arguments before forwarding to the API.
 * Prevents malicious payloads and enforces reasonable limits.
 * Recurses into nested objects and arrays to enforce string length and ID range checks.
 * Throws McpError with INVALID_PARAMS code on validation failure.
 */
export function validateInput(
  args: Record<string, unknown>,
  schema?: InputSchema,
  depth = 0
): void {
  assertDepth(depth);

  for (const [key, value] of Object.entries(args)) {
    const valueSchema = propertySchema(schema, key);

    // String length check
    const maxStringLength = stringLimit(valueSchema);
    if (typeof value === 'string' && value.length > maxStringLength) {
      throw McpErrorFactory.invalidParams(
        `Parameter "${key}" exceeds maximum length (${maxStringLength} characters)`,
        { parameter: key, maxLength: maxStringLength }
      );
    }

    // ID fields: accept number or numeric string, must be positive integer
    if (shouldValidateSingularId(key, valueSchema)) {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw McpErrorFactory.invalidParams(
          `Parameter "${key}" must be a string or number, got ${typeof value}`,
          { parameter: key }
        );
      }
      if (!isValidId(value)) {
        throw McpErrorFactory.invalidParams(`Parameter "${key}" must be a positive integer`, {
          parameter: key,
        });
      }
    }

    // Plural ID fields (e.g., site_ids): must be an array of valid positive integers
    if (shouldValidatePluralIds(key, valueSchema)) {
      if (!Array.isArray(value)) {
        throw McpErrorFactory.invalidParams(`"${key}" must be an array`, { parameter: key });
      }
      for (const item of value) {
        if (typeof item !== 'string' && typeof item !== 'number') {
          throw McpErrorFactory.invalidParams(
            `Element in "${key}" must be a string or number, got ${typeof item}`,
            { parameter: key }
          );
        }
        if (!isValidId(item)) {
          throw McpErrorFactory.invalidParams(`Element in "${key}" must be a positive integer`, {
            parameter: key,
          });
        }
      }
    }

    // Array validation
    if (Array.isArray(value)) {
      validateArray(key, value, valueSchema, depth);
    }

    // Nested object: recurse to validate contents (string lengths, ID ranges, depth)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      validateInput(value as Record<string, unknown>, valueSchema, depth + 1);
    }
  }
}

function validateArray(
  key: string,
  value: unknown[],
  schema: InputSchema | undefined,
  depth: number
): void {
  assertDepth(depth);
  if (value.length > MAX_ARRAY_ELEMENTS) {
    throw McpErrorFactory.invalidParams(
      `Parameter "${key}" has too many elements (max ${MAX_ARRAY_ELEMENTS})`,
      { parameter: key, maxElements: MAX_ARRAY_ELEMENTS, actualElements: value.length }
    );
  }

  for (const [index, item] of value.entries()) {
    const itemSchema = arrayItemSchema(schema, index);
    const maxItemLength = stringLimit(itemSchema);
    if (typeof item === 'string' && item.length > maxItemLength) {
      throw McpErrorFactory.invalidParams(
        `Element in "${key}" exceeds maximum length (${maxItemLength} characters)`,
        { parameter: key, maxLength: maxItemLength }
      );
    }
    if (Array.isArray(item)) {
      validateArray(key, item, itemSchema, depth + 1);
    } else if (typeof item === 'object' && item !== null) {
      validateInput(item as Record<string, unknown>, itemSchema, depth + 1);
    }
  }
}

// Value-based redaction of the server's own credentials. The pattern rules in
// sanitizeError are enumerative - each covers one serialization shape, and
// encodings compose (JSON-in-JSON, URLSearchParams, encodeURI, print_r, ...),
// so a shape will always exist that no rule anticipates. The secrets that
// realistically appear in a remote error body are the ones this server sent,
// and those it knows by value, so literal-occurrence redaction is closed under
// any encoding that preserves the byte sequence. Registered once at server
// startup; registration is additive so a second server instance in the same
// process never strips the first one's protection (tests reset with
// clearKnownSecrets).
export const MIN_KNOWN_SECRET_LENGTH = 8;
/**
 * Ceiling on the process-lifetime registry. Registration is additive and every
 * entry is scanned by every redaction call, so a caller that registers per
 * request (first-run setup accepts a password as a tool argument) would
 * otherwise grow memory and slow sanitizeError without bound. Startup
 * registers at most three secrets and a successful setup two more, so a real
 * server stays far below this.
 */
const MAX_KNOWN_SECRET_VARIANTS = 64;
let knownSecretVariants: string[] = [];

/**
 * A credential to protect. A plain string is matched only in the shapes that
 * preserve its bytes; wrapping a value with appPasswordSecret also matches the
 * form WordPress compares, which is a different string. Nothing else may be
 * canonicalized that way: an API token or a Basic blob with its punctuation
 * stripped is not the credential, and the stripped string can collide with
 * ordinary text.
 */
export type KnownSecret = string | { readonly applicationPassword: string };

/** Tag a value as a WordPress Application Password for the redactors. */
export function appPasswordSecret(value: string | undefined): KnownSecret | undefined {
  return value === undefined ? undefined : { applicationPassword: value };
}

function secretText(secret: KnownSecret): string {
  return typeof secret === 'string' ? secret : secret.applicationPassword;
}

/**
 * The form wp_authenticate_application_password compares: every
 * non-alphanumeric removed. A password pasted with the hyphens or spaces a
 * user copied still authenticates, so this form is the same credential.
 */
export function appPasswordCanonicalForm(value: string): string {
  return value.replace(/[^a-z\d]/gi, '');
}

/**
 * The serialization shapes one secret can take while still appearing as a
 * single literal byte sequence. Literal-occurrence redaction is closed under
 * any encoding that preserves the byte sequence; these are the ones that do
 * not.
 */
function secretVariants(secret: KnownSecret): string[] {
  const value = secretText(secret);
  const variants = [
    value,
    // URLSearchParams turns spaces into '+', encodeURI/encodeURIComponent
    // percent-escape them.
    value.split(' ').join('+'),
    // application/x-www-form-urlencoded (URLSearchParams): '+' for spaces plus
    // %XX for punctuation like '!' and '~' that encodeURIComponent leaves raw.
    // Lone surrogates do not throw here; they encode as the replacement
    // character, which is itself a shape worth matching.
    new URLSearchParams([['x', value]]).toString().slice(2),
    // JSON string escaping. Remote error bodies are commonly JSON, so a
    // password containing a quote, a backslash, or a control character arrives
    // as `ab\"cd` and no match on the raw value can see it.
    JSON.stringify(value).slice(1, -1),
  ];
  // Both throw URIError on a lone surrogate, and a password reaches here from
  // chat input, so an unpaired surrogate is reachable. Guarded separately so a
  // throw costs only that one variant, never the raw value or the redactor.
  for (const encode of [encodeURIComponent, encodeURI]) {
    try {
      variants.push(encode(value));
    } catch {
      // Nothing to add: this encoding cannot represent the value at all, so no
      // diagnostic can contain the secret in it either.
    }
  }
  // A credential is stored and sent exactly as it was pasted, whitespace and
  // all, while the far side may ignore that whitespace. The trimmed and
  // space-free forms are matched for every secret because a diagnostic quoting
  // either one is quoting the value the server sent.
  for (const form of [value.trim(), value.split(' ').join('')]) {
    if (form && !variants.includes(form)) variants.push(form);
  }
  if (typeof secret !== 'string') {
    // Application Passwords only: WordPress removes every non-alphanumeric
    // before comparing, so the compact form authenticates and a Dashboard can
    // echo it back.
    const canonical = appPasswordCanonicalForm(value);
    if (canonical && !variants.includes(canonical)) variants.push(canonical);
  }
  return variants;
}

function replaceVariants(text: string, variants: string[]): string {
  let working = text;
  for (const variant of variants) {
    if (working.includes(variant)) {
      working = working.split(variant).join('[redacted]');
    }
  }
  return working;
}

/** Longest-first, so a secret that another secret prefixes is replaced before
 * the prefix can break its match. */
function orderVariants(variants: Set<string>): string[] {
  return [...variants].sort((a, b) => b.length - a.length);
}

export function clearKnownSecrets(): void {
  knownSecretVariants = [];
}

/**
 * Add secrets to the process-lifetime registry.
 *
 * Returns false when the ceiling kept a variant out: the caller is then holding
 * a credential this process cannot scrub from its own output, which no caller
 * may discover only by watching a secret appear in a diagnostic.
 */
export function registerKnownSecrets(secrets: (KnownSecret | undefined)[]): boolean {
  return addKnownSecrets(secrets, true);
}

/**
 * Whether the registry still has room for every variant of these secrets,
 * without registering anything. A path that is about to transmit a submitted
 * credential asks first: registration is earned only after the credential is
 * validated and saved, and by then the transmission cannot be taken back.
 */
export function canRegisterKnownSecrets(secrets: (KnownSecret | undefined)[]): boolean {
  return addKnownSecrets(secrets, false);
}

function addKnownSecrets(secrets: (KnownSecret | undefined)[], apply: boolean): boolean {
  const variants = new Set<string>(knownSecretVariants);
  let complete = true;
  for (const secret of secrets) {
    if (secret === undefined) continue;
    // A short value would redact ordinary prose; real app passwords, tokens,
    // and base64 Basic blobs are all far longer.
    if (secretText(secret).length < MIN_KNOWN_SECRET_LENGTH) continue;
    for (const variant of secretVariants(secret)) {
      // A derived form can be shorter than the value that cleared the floor:
      // removing the spaces from "ab cd ef g" leaves seven characters, and a
      // short entry in a process-lifetime registry erases ordinary prose for
      // the rest of the run.
      if (variant.length < MIN_KNOWN_SECRET_LENGTH) continue;
      if (variants.has(variant)) continue;
      // Checked per variant, not once per secret, so the ceiling holds even
      // mid-secret. The variants added before the ceiling is reached stay: they
      // cover the value in the shapes they match, and dropping them would
      // protect it less. What matters is that the caller learns the coverage is
      // partial, which is what the false return says, because a secret only
      // half in the registry is one the redactors can still miss.
      if (variants.size >= MAX_KNOWN_SECRET_VARIANTS) {
        complete = false;
        continue;
      }
      variants.add(variant);
    }
  }
  if (apply) knownSecretVariants = orderVariants(variants);
  return complete;
}

/**
 * Build a redactor for values that belong to a single request and must never
 * join the process-wide registry. First-run setup takes a password as a tool
 * argument, and a value from a refused call would otherwise be scanned by
 * every later redaction for the life of the process.
 *
 * Exact by value with no length floor, unlike registerKnownSecrets: the floor
 * there stops a short registered value from erasing ordinary prose forever,
 * while the only text a request-scoped redactor ever touches is that request's
 * own output.
 */
export function createSecretRedactor(
  secrets: (KnownSecret | undefined)[]
): (message: string) => string {
  const ordered = buildVariants(secrets);
  if (ordered.length === 0) {
    return message => message;
  }
  return message => replaceVariants(message, ordered);
}

function buildVariants(secrets: (KnownSecret | undefined)[]): string[] {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret === undefined || secretText(secret) === '') continue;
    for (const variant of secretVariants(secret)) {
      variants.add(variant);
    }
  }
  return orderVariants(variants);
}

/**
 * Secrets belonging to one in-flight call, honored by every redaction in this
 * module for the duration of that call and never added to the registry.
 *
 * First-run setup has to validate a submitted password against a
 * model-supplied Dashboard before the password has earned registration, and a
 * hostile Dashboard can reflect it in an ability name, a schema key, or a
 * label. Those are scrubbed and rejected deep inside the fetch boundary, far
 * from the handler that knows the value, so the value travels as async-local
 * context instead of as a parameter threaded through every call site. Async
 * storage, not a module flag, so a request running outside the scope never
 * inherits it.
 */
const scopedSecrets = new AsyncLocalStorage<string[]>();

export function withScopedSecrets<T>(
  secrets: (KnownSecret | undefined)[],
  fn: () => Promise<T>
): Promise<T> {
  const variants = buildVariants(secrets);
  return variants.length === 0 ? fn() : scopedSecrets.run(variants, fn);
}

/** Registered secrets plus any scoped ones, ordered longest-first across both. */
function activeVariants(): string[] {
  const scoped = scopedSecrets.getStore();
  if (scoped === undefined) {
    return knownSecretVariants;
  }
  return orderVariants(new Set([...knownSecretVariants, ...scoped]));
}

/**
 * Replace every registered secret (in each encoding registerKnownSecrets
 * covers) with a placeholder, leaving the rest of the text alone.
 *
 * Split out from sanitizeError for output that must survive intact: the
 * first-run setup guidance is long-form prose, so the 500-character cap and
 * the key=value patterns of the full sanitizer would mangle it, while the
 * by-value scrub is exactly what a credential-carrying path needs.
 */
export function redactKnownSecrets(message: string): string {
  return replaceVariants(message, activeVariants());
}

/**
 * Depth ceiling for redactStringsDeep. The values it walks are attacker
 * controlled — a parsed execution result, a log payload — and JSON.parse
 * accepts nesting tens of thousands deep inside a size-capped body while the
 * walk costs one stack frame per level. Real ability results and log data nest
 * a handful of levels, so this is generous against anything genuine and still
 * far below the stack limit.
 */
const MAX_REDACT_DEPTH = 100;

/**
 * Replaces a subtree that sits past the depth cap. Dropping it is the safe
 * direction: returning it unwalked would ship a subtree that can still hold the
 * credential the caller asked to have removed. A marker rather than an empty
 * container, so a consumer cannot read truncated output as real data.
 */
export const DEPTH_LIMIT_MARKER = '[removed: nesting depth limit exceeded]';

/**
 * Apply `redact` to every string inside a parsed JSON value — string values
 * and object keys — leaving non-string scalars, types, and structure alone.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced by DEPTH_LIMIT_MARKER.
 *
 * Redacting the raw body text instead would replace across JSON syntax: a
 * secret that is a bare numeric string, or that straddles the punctuation
 * between two fields, rewrites the document into something JSON.parse rejects.
 */
export function redactStringsDeep(
  value: unknown,
  redact: (text: string) => string,
  depth = 0
): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Only containers are cut: a scalar at any depth is already fully handled
  // above, and the cap exists to stop the recursion, not to drop safe values.
  if (depth >= MAX_REDACT_DEPTH) {
    return DEPTH_LIMIT_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactStringsDeep(item, redact, depth + 1));
  }
  // Null prototype: JSON.parse makes a "__proto__" key an own property, and
  // plain assignment on a normal object would hand it to the prototype
  // setter and silently drop it.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    out[redact(key)] = redactStringsDeep(child, redact, depth + 1);
  }
  return out;
}

/** redactStringsDeep against the active secrets, skipping the walk when there are none. */
export function redactKnownSecretsDeep(value: unknown): unknown {
  const variants = activeVariants();
  if (variants.length === 0) {
    return value;
  }
  return redactStringsDeep(value, text => replaceVariants(text, variants));
}

/**
 * True when a registered secret occurs literally in the value. Used at the
 * ability-fetch boundary for fields whose meaning redaction would change
 * (an ability name, a schema key): those are dropped, not rewritten.
 */
export function containsKnownSecret(value: string): boolean {
  return activeVariants().some(variant => value.includes(variant));
}

/**
 * Sanitize error messages before returning to clients.
 * Removes potentially sensitive information like file paths, credentials, and stack traces.
 */
export function sanitizeError(message: string): string {
  // Known-secret pass runs on the FULL message, before the regex cap: literal
  // split/join is linear on a 64KB body, and a secret straddling the cap must
  // be removed whole, not truncated into an unrecognizable fragment.
  const working = redactKnownSecrets(message);
  // Bound the working string before any regex runs. The input can be a 64KB
  // remote error body; without this cap the stack-trace pattern below (and the
  // other backtracking-capable patterns) could be driven into pathological,
  // event-loop-blocking backtracking by a hostile body.
  const truncated = working.length > MAX_SANITIZE_INPUT_LENGTH;
  const bounded = truncated ? working.slice(0, MAX_SANITIZE_INPUT_LENGTH) : working;
  let out = bounded
    // Remove absolute file paths (Unix: /home/..., /var/..., macOS: /Users/...)
    .replace(/\/(Users|home|var|tmp|etc|usr|opt)\/[\w\-./]+/gi, '[path]')
    // Remove Windows paths
    .replace(/[A-Z]:\\[\w\-\\./]+/gi, '[path]')
    // Remove credentials in URLs (user:pass@host)
    .replace(/(https?:\/\/)[^:]+:[^@]+@/g, '$1[redacted]@')
    // Remove Bearer tokens (Authorization: Bearer xxx)
    .replace(/Bearer\s+[\w\-._~+/]+=*/gi, 'Bearer [redacted]')
    // Remove HTTP Basic credentials (Authorization: Basic base64(user:appPassword)).
    // This is the scheme the server itself sends by default (see getAuthHeaders in
    // config.ts). The base64 blob never contains spaces, so a bounded base64 class
    // covers the whole credential; the {16,} floor keeps ordinary "Basic <word>"
    // prose (e.g. "Basic authentication") out of the match while every real
    // credential (base64 of user:app-password) is far longer.
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{16,}/gi, 'Basic [redacted]')
    // Redact any Authorization header value to end-of-line. Covers dumped headers
    // where the scheme token varies or the raw value carries internal spaces, e.g.
    // "Authorization: Basic xxx", "Proxy-Authorization: ...", and PHP $_SERVER dumps
    // like "HTTP_AUTHORIZATION => Basic xxx". Redacting to EOL (not to the first
    // space) prevents leaking a spaced WordPress application password.
    // The optional quote after the name (and before the value) keeps JSON bodies
    // like {"Authorization":"Digest ..."} inside the match; remote errors are
    // commonly JSON and the closing quote would otherwise split name from ':'.
    .replace(
      /(?:\[((?:HTTP_)?(?:Proxy-)?Authorization)\]\s*=>|\b((?:HTTP_)?(?:Proxy-)?Authorization)\b(?:\\*["'])?\s*(?::|=>|=))\s*(?:\\*["'])?\S[^\r\n]*/gi,
      '$1$2: [redacted]'
    )
    // Remove potential tokens/keys in key=value patterns (handles quoted values with spaces)
    // Matches: TOKEN=xxx, MAINWP_TOKEN=xxx, password: "xxx", PHP dumps with '=>',
    // JSON forms like "appPassword":"xxx", and nested-JSON forms like
    // \"appPassword\":\"xxx\" - the optional (possibly backslash-escaped) quote
    // between key and separator is what keeps serialized keys from dodging every
    // rule in this group. '=>' must precede '=' in the alternation or '=' wins
    // and leaves '>' to break the value match.
    .replace(
      /\[?\b(\w*(?:token|password|secret|key|auth|credential))\]?(?:\\*["'])?\s*(?:=>|=|:)\s*"[^"]*"/gi,
      '$1=[redacted]'
    )
    .replace(
      /\[?\b(\w*(?:token|password|secret|key|auth|credential))\]?(?:\\*["'])?\s*(?:=>|=|:)\s*'[^']*'/gi,
      '$1=[redacted]'
    )
    // Known secret key followed by an unquoted (or escape-quoted) WordPress
    // application-password value: exactly six space-separated groups of 4.
    // Partial forms are handled only by the truncation-seam rule below, so
    // ordinary short-word diagnostics ("api_key: must be non empty") are not
    // swallowed. Must run before the generic unquoted rule, which stops at the
    // first space.
    .replace(
      /\[?\b(\w*(?:token|password|secret|key|auth|credential))\]?(?:\\*["'])?\s*(?:=>|=|:)\s*(?:\\*["'])?[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{4}){5}/gi,
      '$1=[redacted]'
    )
    // URL-encoded serialization (%22key%22%3A%22a%20b...%22): the key is still
    // readable but separators and spaces are percent-escaped, so none of the
    // rules above can see it. Matched directly rather than decoding the whole
    // diagnostic and rewriting it.
    .replace(
      /\b(\w*(?:authorization|token|password|secret|key|auth|credential))(?:(?:%22)?(?:%3A|%3D)|%22[:=])(?:%22)?(?:[A-Za-z0-9._~!*'()-]|%[0-9A-Fa-f]{2}|\+)+/gi,
      '$1=[redacted]'
    );
  // The input cap can cut a spaced password mid-group, and the cut can only land
  // at the end of the bounded string - so a partial-group form is accepted there
  // and nowhere else. An unanchored tolerant rule was tried first and it erased
  // ordinary short-word diagnostics ("API key: must be set").
  if (truncated) {
    // The trailing class absorbs whatever residue the cut leaves after the last
    // group: a space, or the quote/backslash of a severed JSON value.
    out = out.replace(
      /\[?\b(\w*(?:token|password|secret|key|auth|credential))\]?(?:\\*["'])?\s*(?:=>|=|:)\s*(?:\\*["'])?[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{1,4}){0,5}(?:\s[A-Za-z0-9]{1,3})?[\s\\"']*$/i,
      '$1=[redacted]'
    );
  }
  return (
    out
      .replace(
        /\[?\b(\w*(?:token|password|secret|key|auth|credential))\]?(?:\\*["'])?\s*(?:=>|=|:)\s*(?:\\*["'])?[\w\-._~+/]+=*/gi,
        '$1=[redacted]'
      )
      // Remove stack traces (at Function.name (file:line:col)).
      // Character classes that exclude '(' , ')' and newline replace the two
      // adjacent greedy `.+` groups, so the '(' delimiter splits the match
      // deterministically and the pattern runs in linear time (no quadratic
      // backtracking on inputs full of '(').
      .replace(/\s+at\s+[^()\n]+\([^()\n]*:\d+:\d+\)/g, '')
      // Remove Node.js internal paths
      .replace(/\(node:[\w]+:\d+:\d+\)/g, '')
      // Truncate to reasonable length
      .slice(0, 500)
      .trim()
  );
}

/**
 * Token bucket rate limiter to prevent API abuse.
 * Throttles requests to a configurable rate per minute.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.refillRate = requestsPerMinute / 60000;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary.
   * Returns immediately if rate limiting is disabled (maxTokens = 0).
   * @param signal - Optional AbortSignal to cancel the wait
   * @param maxWaitMs - Maximum time to wait for a token (default: 30000ms).
   *   Prevents indefinite blocking when the rate limit is very low.
   */
  async acquire(signal?: AbortSignal, maxWaitMs = 30000): Promise<void> {
    if (this.maxTokens === 0) return; // Disabled
    this.refill();
    if (this.tokens < 1) {
      if (signal?.aborted) {
        throw new Error('Rate limiter acquire aborted');
      }
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
      if (waitTime > maxWaitMs) {
        throw new Error(`Rate limit wait time (${waitTime}ms) exceeds maximum (${maxWaitMs}ms)`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, waitTime);
        const onAbort = () => {
          clearTimeout(timer);
          cleanup();
          reject(new Error('Rate limiter acquire aborted'));
        };
        const cleanup = () => {
          signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

/**
 * Check if a value is a valid positive integer ID
 */
export function isValidId(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= Number.MAX_SAFE_INTEGER;
  }
  if (typeof value === 'string') {
    // Decimal digits only — Number() alone would also accept "1e3", "0x10",
    // "+7", and " 8 ", where local validation and upstream interpretation of
    // the raw forwarded string can disagree.
    if (!/^\d+$/.test(value)) {
      return false;
    }
    const num = Number(value);
    return Number.isSafeInteger(num) && num >= 1;
  }
  return false;
}
