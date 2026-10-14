import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import {
  createProvider, openAICompletionsApi, openAIResponsesApi, createAssistantMessageEventStream,
  type AnyModel, type Api, type Model, type Provider, type RefreshModelsContext,
  type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const ID = "llama-swap";
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const PROVISIONAL_CONTEXT_WINDOW = 32768;
const PENDING_SUFFIX = " [context pending]";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
type Fetch = typeof globalThis.fetch;
type RecordValue = Record<string, unknown>;
type Override = {
  type?: "chat" | "classifier" | "ignore";
  reasoning?: boolean;
  thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
  maxTokens?: number;
  contextWindow?: number;
  fallbackContextWindow?: number;
  upstreamModelId?: string;
  compat?: Model<"openai-completions">["compat"];
};
export interface Config {
  api?: "openai-completions" | "openai-responses";
  parallelToolCalls?: boolean;
  id?: string;
  name?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  tlsVerify?: boolean;
  loadTimeoutMs?: number;
  baseUrl: string;
  timeoutMs: number;
  defaultMaxTokens: number;
  modelOverrides: Record<string, Override>;
}
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function modelId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 512
    && value !== "." && value !== ".." && !/[\x00-\x1f\x7f]/u.test(value);
}
export interface ServerConfig extends Config { id: string; name: string; api: "openai-completions" | "openai-responses" }
export type SwapModel = AnyModel & { contextPending: boolean; dynamicContext: boolean };
type PrepareOptions = { signal?: AbortSignal; apiKey?: string; fetch?: Fetch; force?: boolean };
export interface LlamaSwapProvider extends Provider {
  prepareModel(model: AnyModel, options?: PrepareOptions): Promise<SwapModel>;
  isPrepared(model: AnyModel): boolean;
  onModelPrepared?: (model: SwapModel) => Promise<void>;
}
function validateConfig(value: unknown): ServerConfig {
  if (!record(value) || Object.keys(value).some(key => !["id", "name", "api", "apiKey", "apiKeyEnv", "tlsVerify", "parallelToolCalls", "loadTimeoutMs", "baseUrl", "timeoutMs", "defaultMaxTokens", "modelOverrides"].includes(key))) {
    throw new Error("Invalid llama-swap configuration fields");
  }
  if (typeof value.baseUrl !== "string" || !positive(value.timeoutMs) || !positive(value.defaultMaxTokens) || !record(value.modelOverrides)) {
    throw new Error("llama-swap needs baseUrl, positive timeoutMs/defaultMaxTokens, and modelOverrides");
  }
  if (Object.hasOwn(value, "api") && value.api !== "openai-completions" && value.api !== "openai-responses") throw new Error("Invalid llama-swap chat API");
  if (value.timeoutMs > MAX_TIMEOUT_MS) throw new Error("timeoutMs exceeds the timer limit");
  const id = value.id ?? ID;
  const name = value.name ?? id;
  if (typeof id !== "string" || id.length > 64 || !/^llama-swap(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/u.test(id)) {
    throw new Error("Server id must be llama-swap or llama-swap-<lowercase-name>");
  }
  if (typeof name !== "string" || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/u.test(name)) throw new Error("Invalid llama-swap server name");
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || !value.apiKey.trim() || /[\x00-\x1f\x7f]/u.test(value.apiKey))) throw new Error("apiKey must be a nonblank string without controls");
  if (value.apiKey !== undefined && value.apiKeyEnv !== undefined) throw new Error("Configure only one of apiKey or apiKeyEnv");
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.apiKeyEnv))) throw new Error("apiKeyEnv must name an environment variable");
  if (Object.hasOwn(value, "tlsVerify") && typeof value.tlsVerify !== "boolean") throw new Error("tlsVerify must be boolean");
  if (Object.hasOwn(value, "parallelToolCalls") && typeof value.parallelToolCalls !== "boolean") throw new Error("parallelToolCalls must be boolean");
  if (Object.hasOwn(value, "loadTimeoutMs") && (!positive(value.loadTimeoutMs) || value.loadTimeoutMs > MAX_TIMEOUT_MS)) throw new Error("Invalid loadTimeoutMs");
  const url = new URL(value.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/u.test(value.baseUrl)) throw new Error("llama-swap baseUrl must be HTTP(S) without credentials, query, or fragment");
  for (const [id, override] of Object.entries(value.modelOverrides)) {
    if (!modelId(id) || !record(override) || Object.keys(override).some(key => !["type", "reasoning", "thinkingLevelMap", "maxTokens", "contextWindow", "fallbackContextWindow", "upstreamModelId", "compat"].includes(key))) throw new Error("Invalid llama-swap model override");
    if (override.upstreamModelId !== undefined && !modelId(override.upstreamModelId)) throw new Error("Invalid upstream model ID");
    if (override.type !== undefined && (typeof override.type !== "string" || !["chat", "classifier", "ignore"].includes(override.type))) throw new Error("Invalid model type override");
    if (override.reasoning !== undefined && typeof override.reasoning !== "boolean") throw new Error("reasoning must be boolean");
    if (Object.hasOwn(override, "thinkingLevelMap")) {
      if (!record(override.thinkingLevelMap)) throw new Error("thinkingLevelMap must be an object");
      for (const [level, effort] of Object.entries(override.thinkingLevelMap)) {
        if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)
            || (effort !== null && (typeof effort !== "string" || !effort.trim() || /[\x00-\x1f\x7f]/u.test(effort)))) {
          throw new Error("Invalid thinkingLevelMap entry");
        }
      }
    }
    for (const key of ["maxTokens", "contextWindow", "fallbackContextWindow"]) {
      if (override[key] !== undefined && !positive(override[key])) throw new Error(`${key} must be positive`);
    }
    if (override.compat !== undefined) {
      if (!record(override.compat)) throw new Error("compat must be an object");
      for (const [key, setting] of Object.entries(override.compat)) {
        if (value.api === "openai-responses" && key !== "supportsDeveloperRole") throw new Error("Unsupported Responses compat override field");
        if (["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort"].includes(key)) {
          if (typeof setting !== "boolean") throw new Error("compat flag must be boolean");
        } else if (key === "maxTokensField") {
          if (setting !== "max_tokens" && setting !== "max_completion_tokens") throw new Error("Invalid maxTokensField");
        } else throw new Error("Unsupported compat override field");
      }
    }
  }
  return { ...value, id, name, api: value.api ?? "openai-completions", tlsVerify: value.tlsVerify ?? true, loadTimeoutMs: value.loadTimeoutMs ?? 120000,
    baseUrl: value.baseUrl.replace(/\/+$/u, ""),
    apiKeyEnv: value.apiKeyEnv ?? (value.id === undefined && value.apiKey === undefined ? "LLAMA_SWAP_API_KEY" : undefined),
  } as unknown as ServerConfig;
}
export function parseConfig(value: unknown): ServerConfig[] {
  if (!record(value)) throw new Error("Invalid llama-swap configuration");
  if (!Object.hasOwn(value, "servers")) {
    if (Object.keys(value).some(key => !["api", "apiKey", "tlsVerify", "parallelToolCalls", "loadTimeoutMs", "baseUrl", "timeoutMs", "defaultMaxTokens", "modelOverrides"].includes(key))) throw new Error("Invalid legacy llama-swap configuration fields");
    return [validateConfig(value)];
  }
  if (Object.keys(value).length !== 1 || !Array.isArray(value.servers) || value.servers.length === 0) throw new Error("Configure only a non-empty servers list, or the legacy single-server fields");
  const seen = new Set<string>();
  return value.servers.map(server => {
    if (!record(server) || typeof server.id !== "string") throw new Error("Each server needs an id");
    const normalized = validateConfig({ timeoutMs: 3000, defaultMaxTokens: 4096, modelOverrides: {}, ...server });
    if (seen.has(normalized.id)) throw new Error("Duplicate llama-swap server id");
    seen.add(normalized.id);
    return normalized;
  });
}
// The opt-out affects this origin only. No shared agents or TLS environment changes.
function serverFetch(config: Config): Fetch {
  if (config.tlsVerify !== false) return globalThis.fetch;
  const origin = new URL(config.baseUrl).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || url.origin !== origin) return globalThis.fetch(input, init);
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    // node:https does not decode compressed response bodies like native fetch.
    headers.set("accept-encoding", "identity");
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest(url, { method: request.method, headers: Object.fromEntries(headers),
        rejectUnauthorized: false, agent: false, signal: request.signal }, incoming => {
        try {
          const status = incoming.statusCode ?? 500;
          const encoding = incoming.headers["content-encoding"];
          if (status >= 300 && status < 400) {
            incoming.destroy(); reject(new Error("llama-swap HTTPS redirects are prohibited")); return;
          }
          if (encoding && encoding.toLowerCase() !== "identity") {
            incoming.destroy(); reject(new Error("llama-swap HTTPS response encoding is unsupported")); return;
          }
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          const noBody = request.method === "HEAD" || status === 204 || status === 205;
          if (noBody) incoming.resume();
          const response = new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
            { status, headers: responseHeaders });
          Object.defineProperty(response, "url", { value: request.url });
          resolve(response);
        } catch {
          incoming.destroy(); reject(new Error("llama-swap returned an invalid HTTPS response"));
        }
      });
      outgoing.on("error", reject);
      outgoing.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("llama-swap HTTPS upgrades are prohibited")); });
      outgoing.end(body);
    });
  };
}
// Discovery responses are untrusted metadata, not executable configuration.
async function readJson(response: Response, signal?: AbortSignal | null): Promise<unknown> {
  if (!response.body) throw new Error(`llama-swap HTTP ${response.status}: no body`);
  const reader = response.body.getReader();
  // Do not await cancellation: a transport's cancel callback can itself block.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new Error("llama-swap metadata exceeds 2 MiB");
      chunks.push(value);
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (!response.ok) throw new Error(`llama-swap HTTP ${response.status}`);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("llama-swap returned invalid JSON"); }
}
export function mapCatalog(body: unknown, config: Config): SwapModel[] {
  if (!record(body) || !Array.isArray(body.data) || body.data.length > 1000) throw new Error("Invalid llama-swap model listing");
  const seen = new Set<string>();
  const models: SwapModel[] = [];
  for (const item of body.data) {
    if (!record(item) || !modelId(item.id)) throw new Error("Invalid llama-swap model ID");
    if (typeof item.name === "string" && (item.name.length > 512 || /[\x00-\x1f\x7f]/u.test(item.name))) throw new Error("Invalid llama-swap model name");
    if (seen.has(item.id)) throw new Error("Duplicate llama-swap model ID");
    seen.add(item.id);
    const override = Object.hasOwn(config.modelOverrides, item.id) ? config.modelOverrides[item.id] : {};
    if (override.type === "ignore") continue;
    const architecture = record(item.architecture) ? item.architecture : {};
    const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
    const type = override.type ?? (outputs.includes("decisions") ? "classifier" : "chat");
    if (!override.type && outputs.length && !outputs.includes("text") && !outputs.includes("decisions")) continue;
    const meta = record(item.meta) ? item.meta : {};
    const knownContext = override.contextWindow ?? [item.context_length, item.context_window, meta.n_ctx].find(positive) ?? override.fallbackContextWindow;
    const contextPending = !positive(knownContext);
    const contextWindow = knownContext ?? PROVISIONAL_CONTEXT_WINDOW;
    const common = { id: item.id, provider: config.id ?? ID,
      name: (typeof item.name === "string" && item.name.trim() ? item.name : item.id) + (contextPending ? PENDING_SUFFIX : ""),
      cost: { ...ZERO_COST }, contextWindow, contextPending, dynamicContext: contextPending || record(item.status) };
    if (type === "classifier") {
      models.push({ ...common, type, api: "typesafe-system-one", input: ["text"], baseUrl: `${config.baseUrl}/upstream/${encodeURIComponent(item.id)}/v1` });
    } else {
      const inputs: ("text" | "image")[] = ["text"];
      if (Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image")) inputs.push("image");
      models.push({ ...common, type: "chat", api: config.api ?? "openai-completions", baseUrl: `${config.baseUrl}/v1`, input: inputs,
        reasoning: override.reasoning ?? false,
        thinkingLevelMap: override.thinkingLevelMap === undefined ? undefined : { ...override.thinkingLevelMap },
        maxTokens: Math.min(override.maxTokens ?? config.defaultMaxTokens, contextWindow), compat: override.compat });
    }
  }
  return models;
}
// Queued cancellation rejects immediately and prevents dispatch. Once started,
// signal-aware I/O owns cancellation so its final partial result is preserved.
// The lease remains held until that I/O settles, even if a transport ignores abort.
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, queued: () => boolean): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { if (queued()) reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createLlamaSwapProvider(rawConfig: Config, fetchImpl?: Fetch): LlamaSwapProvider {
  const config = validateConfig(rawConfig);
  const transport = fetchImpl ?? serverFetch(config);
  const chatApi = config.api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
  let catalog: SwapModel[] = [];
  let preparedId: string | undefined;
  let lease: Promise<void> = Promise.resolve();
  const withLease = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    let started = false;
    const result = lease.then(() => { signal?.throwIfAborted(); started = true; return operation(); });
    lease = result.then(() => {}, () => {});
    return untilAbort(result, signal, () => !started);
  };
  const apiKey = (key?: string, environmentKey?: string) => {
    const selected = key ?? config.apiKey ?? environmentKey;
    if (selected !== undefined) return selected.trim() ? selected : undefined;
    return config.apiKeyEnv ? undefined : "local";
  };
  const needsPreparation = (model: AnyModel) => Boolean((model as Partial<SwapModel>).dynamicContext
    || (model as Partial<SwapModel>).contextPending || catalog.find(entry => entry.id === model.id)?.dynamicContext);
  const pending = (model: AnyModel) => {
    Object.assign(model, { contextPending: true });
    if (!model.name.endsWith(PENDING_SUFFIX)) model.name += PENDING_SUFFIX;
  };
  const invalidateOthers = (id: string) => {
    for (const entry of catalog) if (entry.dynamicContext && entry.id !== id) pending(entry);
  };
  const markPending = (model: AnyModel) => {
    preparedId = undefined;
    if (needsPreparation(model)) {
      pending(model);
      const entry = catalog.find(entry => entry.id === model.id);
      if (entry) pending(entry);
    }
  };
  const refine = (model: AnyModel, resolved: SwapModel) => {
    if (model.type === resolved.type || (model.type === undefined && resolved.type === "chat")) Object.assign(model, resolved);
  };
  const resolveRuntime = async (model: AnyModel, options: PrepareOptions = {}): Promise<SwapModel> => {
    // Preserve direct calls with caller-supplied, complete static metadata. Do
    // not invent a catalog entry, or let that path bypass a pending model.
    const current = catalog.find(entry => entry.id === model.id)
      ?? (!needsPreparation(model) && "contextWindow" in model && positive(model.contextWindow)
        ? { ...model, type: model.type ?? "chat", contextPending: false, dynamicContext: false } as SwapModel : undefined);
    if (!current) throw new Error("llama-swap model is unavailable");
    if (!needsPreparation(current)) {
      // A complete static entry can still route through the same swap server.
      if (preparedId !== current.id) { preparedId = undefined; invalidateOthers(current.id); }
      return current;
    }
    if (!options.force && preparedId === current.id && !current.contextPending) { refine(model, current); return current; }
    markPending(model);
    const deadline = AbortSignal.timeout(config.loadTimeoutMs!);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const key = apiKey(options.apiKey, config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
    if (!key) throw new Error("llama-swap API key is not configured");
    const request = options.fetch ?? transport;
    const base = `${config.baseUrl}/upstream/${encodeURIComponent(model.id)}`;
    const get = async (path: string) => readJson(await request(base + path, {
      signal, redirect: "error", headers: { Authorization: `Bearer ${key}` },
    }), signal);
    try {
      const body = await get("/v1/models");
      if (!record(body) || !Array.isArray(body.data) || body.data.length !== 1 || !record(body.data[0]) || !modelId(body.data[0].id)) throw new Error("Invalid runtime listing");
      const item = body.data[0];
      const override = config.modelOverrides[model.id] ?? {};
      if (current.type === "classifier" && item.id !== (override.upstreamModelId ?? current.id)) throw new Error("Unexpected classifier identity");
      const owner = typeof item.owned_by === "string" ? item.owned_by.toLowerCase() : undefined;
      const llamaCpp = !owner || ["llamacpp", "llama.cpp", "llama-cpp"].includes(owner);
      const props = llamaCpp ? await get("/props") : undefined;
      const defaults = record(props) && record(props.default_generation_settings) ? props.default_generation_settings : {};
      const meta = record(item.meta) ? item.meta : {};
      const runtimeWindow = llamaCpp ? defaults.n_ctx : [item.context_length, item.context_window, meta.n_ctx].find(positive);
      if (!positive(runtimeWindow)) throw new Error("Missing runtime context");
      const modalities = record(props) && record(props.modalities) ? props.modalities : {};
      const templateCaps = record(props) && record(props.chat_template_caps) ? props.chat_template_caps : {};
      const architecture = record(item.architecture) ? item.architecture : {};
      let inputs = Array.isArray(architecture.input_modalities) ? [...architecture.input_modalities] : ["text"];
      if (modalities.vision === false) inputs = inputs.filter(input => input !== "image");
      if (modalities.vision === true && !inputs.includes("image")) inputs.push("image");
      const window = Math.min(runtimeWindow, override.contextWindow ?? runtimeWindow);
      const next = mapCatalog({ data: [{ ...item, id: current.id,
        name: current.name.endsWith(PENDING_SUFFIX) ? current.name.slice(0, -PENDING_SUFFIX.length) : current.name,
        context_length: window, architecture: { ...architecture, input_modalities: inputs }, status: { value: "loaded" } }] },
      { ...config, modelOverrides: { ...config.modelOverrides, [model.id]: { ...override,
        reasoning: override.reasoning ?? (templateCaps.supports_reasoning_effort === true), contextWindow: window } } })[0];
      signal.throwIfAborted();
      const latest = catalog.find(entry => entry.id === current.id);
      if (!next || !latest) throw new Error("Runtime model disappeared");
      // A read-only refresh can replace the catalog during HTTP preparation.
      // Publish into its latest entry, not the detached starting object.
      next.name = latest.name.endsWith(PENDING_SUFFIX) ? latest.name.slice(0, -PENDING_SUFFIX.length) : latest.name;
      const resolved = next.type === latest.type ? Object.assign(latest, next) : next;
      if (next.type !== latest.type) catalog = catalog.map(entry => entry.id === latest.id ? next : entry);
      invalidateOthers(resolved.id);
      preparedId = resolved.id;
      refine(model, resolved);
      await dynamicProvider.onModelPrepared?.(resolved);
      return resolved;
    } catch {
      markPending(model);
      throw new Error(signal.aborted && options.signal?.aborted ? "llama-swap preparation cancelled" : "llama-swap preparation failed");
    }
  };
  const streamPrepared = (model: Model<Api>, context: TranscriptContext, options: StreamOptions | undefined, simple: boolean) => {
    const output = createAssistantMessageEventStream();
    void withLease(async () => {
      const resolved = await resolveRuntime(model, { ...options, force: true });
      if (resolved.type !== "chat") throw new Error("llama-swap model is a classifier, not a chat model");
      const responses = config.api === "openai-responses";
      const maxTokens = Math.min(options?.maxTokens ?? resolved.maxTokens, resolved.maxTokens, resolved.contextWindow);
      // Pi 1.2.0 raises Responses limits below 16. Do not exceed the caller or model budget.
      if (responses && (!positive(maxTokens) || maxTokens < 16)) throw new Error("Invalid Responses output budget");
      const requestOptions = { ...options, fetch: options?.fetch ?? transport,
        ...(config.parallelToolCalls !== undefined ? { samplingParams: {
          ...options?.samplingParams, parallel_tool_calls: config.parallelToolCalls,
        } } : {}),
        ...(responses || needsPreparation(model) ? { maxTokens } : {}) };
      const requestModel = model.api === config.api ? model : { ...model, api: config.api };
      const inner = simple ? chatApi.streamSimple(requestModel, context, requestOptions)
        : chatApi.stream(requestModel, context, requestOptions);
      for await (const event of inner) output.push(event);
      output.end(await inner.result());
    }, options?.signal).catch(() => {
      const reason = options?.signal?.aborted ? "aborted" : "error";
      output.push({ type: "error", reason, error: { role: "assistant", content: [], api: config.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: reason,
        errorMessage: reason === "aborted" ? "llama-swap request cancelled" : "llama-swap request preparation failed",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } } } });
      output.end();
    });
    return output;
  };
  // Reuse an exported provider factory because Pi aliases the providers/all entry point.
  const nativeClassify = builtinProviders().find(provider => provider.id === "typesafe")?.classify;
  if (!nativeClassify) throw new Error("Pi has no native System One classifier transport");
  const provider = createProvider({
    id: config.id, name: config.name, baseUrl: config.baseUrl, models: [],
    auth: { apiKey: {
      name: config.name,
      resolve: async ({ credential, ctx, signal }) => {
        const key = apiKey(credential?.key, config.apiKeyEnv ? await ctx.env(config.apiKeyEnv) : undefined);
        signal.throwIfAborted();
        return key ? { auth: { apiKey: key } } : undefined;
      },
    } },
    api: {
      stream: (model, context, options) => streamPrepared(model, context, options, false),
      streamSimple: (model, context, options) => streamPrepared(model, context, options, true),
    },
    classifiers: { "typesafe-system-one": {
      classify: async (model, context, options) => {
        const override = Object.hasOwn(config.modelOverrides, model.id) ? config.modelOverrides[model.id] : undefined;
        const upstreamId = override?.upstreamModelId ?? model.id;
        let signal = options?.signal;
        try {
          if (options?.timeoutMs !== undefined) {
            const deadline = AbortSignal.timeout(options.timeoutMs);
            signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
          }
          return await withLease(async () => {
            const resolved = await resolveRuntime(model, { ...options, signal, force: true });
            if (resolved.type !== "classifier") throw new Error("llama-swap model is not a classifier");
            const result = await nativeClassify({ ...model, id: upstreamId }, context, {
              ...options, signal, timeoutMs: undefined, maxRetries: 0,
              fetch: async (url, init) => {
                const fetchRequest = options?.fetch ?? transport;
                signal?.throwIfAborted();
                const advertised = await readJson(await fetchRequest(`${model.baseUrl}/models`, {
                  signal, redirect: "error", headers: init?.headers,
                }), signal);
                if (!record(advertised) || !Array.isArray(advertised.data) || advertised.data.length !== 1
                    || !record(advertised.data[0]) || advertised.data[0].id !== upstreamId) {
                  throw new Error("llama-swap classifier alias does not match selected model");
                }
                signal?.throwIfAborted();
                // Consume once. Cloning would leave an unread tee branch during cancellation.
                const response = await fetchRequest(url, { ...init, signal, redirect: "error" });
                const body = await readJson(response, signal);
                if (!record(body) || body.model !== upstreamId) throw new Error("llama-swap classifier response alias does not match selected model");
                return Response.json(body, { status: response.status, headers: response.headers });
              },
            });
            result.model = model.id;
            if (signal?.aborted) { result.stopReason = "aborted"; result.answers = {}; }
            if (result.stopReason !== "stop") {
              result.errorMessage = result.stopReason === "aborted" ? "llama-swap classification cancelled" : "llama-swap classification failed";
            }
            return result;
          }, signal);
        } catch {
          return { api: model.api, provider: model.provider, model: model.id, answers: {},
            timestamp: Date.now(), stopReason: signal?.aborted ? "aborted" : "error",
            errorMessage: signal?.aborted ? "llama-swap classification cancelled" : "llama-swap classification failed" };
        }
      },
    } },
  });
  const dynamicProvider: LlamaSwapProvider = { ...provider,
    prepareModel: (model, options) => withLease(() => resolveRuntime(model, options), options?.signal),
    isPrepared: model => !needsPreparation(model) || (preparedId === model.id && !(model as Partial<SwapModel>).contextPending
      && !catalog.find(entry => entry.id === model.id)?.contextPending
      && catalog.find(entry => entry.id === model.id)?.type === model.type),
    getModels: () => catalog.filter((model): model is Model<Api> & SwapModel => model.type === "chat"),
    getAllModels: () => catalog,
    refreshModels: async (context: RefreshModelsContext) => {
      if (!context.allowNetwork || context.signal.aborted || process.env.PI_OFFLINE === "1") return;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(config.timeoutMs)]);
      const key = apiKey(context.credential?.type === "api_key" ? context.credential.key : undefined,
        config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
      if (!key) throw new Error("llama-swap API key is not configured");
      const response = await transport(`${config.baseUrl}/v1/models`, { signal, redirect: "error", headers: { Authorization: `Bearer ${key}` } });
      const next = mapCatalog(await readJson(response, signal), config);
      signal.throwIfAborted();
      await context.publish({ update: () => { signal.throwIfAborted(); catalog = next; preparedId = undefined; } });
    },
  };
  return dynamicProvider;
}
export async function registerLlamaSwapServers(pi: ExtensionAPI, rawConfig: unknown, fetchImpl?: Fetch) {
  const providers = parseConfig(rawConfig).map(config => createLlamaSwapProvider(config, fetchImpl));
  const report = (ctx: { hasUI: boolean; ui: { notify(message: string, type: "info" | "warning"): void } }, message: string, warning = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, warning ? "warning" : "info");
    else pi.sendMessage({ customType: "llama-swap-status", content: message, display: true }, { triggerTurn: false });
  };
  const startupFailed = new Set<string>();
  if (process.env.PI_OFFLINE !== "1") {
    await Promise.all(providers.map(async provider => {
      try { await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal, publish: async ({ update }) => { update?.(); return true; } }); }
      catch { startupFailed.add(provider.id); }
    }));
  }
  for (const provider of providers) pi.registerProvider(provider);
  const lifetime = new AbortController();
  let activeContext: ExtensionContext | undefined;
  const blocked = new Set<string>();
  for (const provider of providers) provider.onModelPrepared = async model => {
    const ctx = activeContext;
    if (!ctx || lifetime.signal.aborted) return;
    await ctx.modelRegistry.refresh?.({ providers: [provider.id], allowNetwork: false });
    const selected = ctx.model;
    // Synchronous refinement avoids an async setModel auth check overwriting a
    // newer selection. Metadata changes never create a selection event.
    if (model.type === "chat" && selected?.provider === model.provider && selected.id === model.id) Object.assign(selected, model);
  };
  const prepareSelected = async (ctx: ExtensionContext, force = true) => {
    activeContext = ctx;
    const model = ctx.model;
    const provider = providers.find(entry => entry.id === model?.provider);
    if (!model || !provider) return true;
    if (!(model as Partial<SwapModel>).dynamicContext && !(model as Partial<SwapModel>).contextPending && !provider.getAllModels?.().some(entry => entry.id === model.id && (entry as SwapModel).dynamicContext)) return true;
    const identity = `${model.provider}/${model.id}`;
    try {
      const key = await ctx.modelRegistry.getApiKeyForProvider(provider.id);
      if (!key) throw new Error("Unconfigured provider");
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
      const resolved = await provider.prepareModel(model, { apiKey: key, signal, force });
      if (resolved.type !== "chat") throw new Error("Selected classifier");
      blocked.delete(identity);
      return true;
    } catch {
      blocked.add(identity);
      report(ctx, `llama-swap preparation failed for ${model.provider}/${model.id}. No inference was sent. Select another model or retry.`, true);
      return false;
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    if (startupFailed.size) report(ctx, `llama-swap discovery failed for: ${[...startupFailed].join(", ")}. Check those servers, then run /llama-swap refresh.`, true);
    await prepareSelected(ctx);
  });
  pi.on("model_select", async (_event, ctx) => { await prepareSelected(ctx); });
  pi.on("input", async (_event, ctx) => {
    if (!ctx.isIdle()) return { action: "continue" as const };
    return { action: await prepareSelected(ctx) ? "continue" as const : "handled" as const };
  });
  pi.on("before_agent_start", async (_event, ctx) => { if (!await prepareSelected(ctx, false)) ctx.abort(); });
  pi.on("turn_end", async (_event, ctx) => { if (!await prepareSelected(ctx, false)) ctx.abort(); });
  pi.on("session_before_compact", (_event, ctx) => {
    const provider = providers.find(entry => entry.id === ctx.model?.provider);
    if (ctx.model && provider && (blocked.has(`${ctx.model.provider}/${ctx.model.id}`) || !provider.isPrepared(ctx.model))) return { cancel: true };
  });
  pi.on("session_shutdown", () => { lifetime.abort(); });
  pi.registerCommand("llama-swap", {
    description: "Refresh or inspect llama-swap server catalogs",
    handler: async (args, ctx) => {
      const [action, target, ...extra] = (args.trim() || "status").split(/\s+/u);
      const selected = target ? providers.filter(provider => provider.id === target) : providers;
      if ((action !== "refresh" && action !== "status") || extra.length || selected.length === 0) {
        report(ctx, "Usage: /llama-swap [refresh|status] [server-id]. Servers: " + providers.map(provider => provider.id).join(", "), true); return;
      }
      let warning = "";
      if (action === "refresh") {
        await ctx.waitForIdle();
        const result = await ctx.modelRegistry.refresh({ providers: selected.map(provider => provider.id), allowNetwork: true, force: true, signal: ctx.signal });
        const failed = selected.filter(provider => result.errors.has(provider.id));
        if (failed.length) warning = `Refresh failed for: ${failed.map(provider => provider.id).join(", ")}. Their last good catalogs are unchanged.`;
        if (result.aborted) warning += " Refresh cancelled; servers that completed may already be updated.";
      }
      const status = selected.map(provider => {
        const models = provider.getAllModels!();
        return `${provider.id}: ${models.filter(model => model.type === "chat").length} chat, ${models.filter(model => model.type === "classifier").length} classifier.`;
      }).join("\n");
      report(ctx, `${status}\n${warning || "Use /model to select chat."}`, Boolean(warning));
    },
  });
}
export default async function (pi: ExtensionAPI) {
  const explicit = process.env.LLAMA_SWAP_CONFIG;
  const path = explicit ?? join(getAgentDir(), "llama-swap.json");
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (explicit === undefined && record(error) && error.code === "ENOENT") return;
    throw new Error("Cannot read llama-swap configuration");
  }
  let config: unknown;
  try { config = JSON.parse(text); parseConfig(config); }
  catch { throw new Error("Invalid llama-swap configuration"); }
  await registerLlamaSwapServers(pi, config);
}
