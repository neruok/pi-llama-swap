# pi-llama-swap

Register named llama-swap servers as Pi providers. Discover chat models and native System One classifiers from each server.

This is an unpublished package, validated with Pi 1.2.0.
Loading and inference tests use synthetic servers. Live inference has not been verified.

## Try the extension

1. Copy `llama-swap.example.json` to your own configuration file.
2. Set each server URL to its root, without `/v1`.
3. Replace the example model IDs with your server's IDs.
4. Load the extension for one Pi invocation:

```sh
LLAMA_SWAP_CONFIG=/absolute/path/llama-swap.json pi -e /absolute/path/pi-llama-swap
```

No installation or settings change occurs. Without `LLAMA_SWAP_CONFIG`, the extension reads `<Pi agent directory>/llama-swap.json`.
The usual agent directory is `~/.pi/agent`. Pi's agent-directory override also applies.
An absent default file leaves the extension inactive. An explicit missing or invalid file fails loading.

Chat models appear in `/model`. Classifiers do not appear there.
To discover classifiers through codemode, enable Pi's codemode tool separately.

```text
/llama-swap status
/llama-swap refresh
/llama-swap refresh llama-swap-local
```

Edit the configuration and run `/reload` to change registered servers.
The extension does not switch your active model.

## Configure servers

The top-level object contains a non-empty `servers` array:

```json
{
  "servers": [
    {
      "id": "llama-swap-local",
      "baseUrl": "http://127.0.0.1:8080"
    },
    {
      "id": "llama-swap-gpu",
      "name": "GPU server",
      "baseUrl": "https://gpu.example.com/llama-swap",
      "api": "openai-responses",
      "apiKeyEnv": "GPU_SWAP_API_KEY"
    }
  ]
}
```

Each ID must be unique. Use `llama-swap` or `llama-swap-<lowercase-name>`.
Servers can share model IDs without sharing credentials or catalogs.
Reverse-proxy path prefixes are supported. URL credentials, queries, and fragments are prohibited.

| Field | Meaning |
| --- | --- |
| `id` | Required provider ID in a servers entry |
| `name` | Display name, defaults to the ID |
| `baseUrl` | Required HTTP(S) server root |
| `api` | Chat API: `openai-completions` (default) or `openai-responses` |
| `apiKey` | Optional literal API key stored in this configuration file |
| `apiKeyEnv` | Optional environment variable name, instead of `apiKey` |
| `tlsVerify` | Boolean certificate verification toggle, defaults to `true` |
| `timeoutMs` | Discovery deadline, defaults to 3000 ms |
| `loadTimeoutMs` | Selected-model preparation deadline, defaults to 120000 ms |
| `defaultMaxTokens` | Chat output limit, defaults to 4096 tokens |
| `modelOverrides` | Metadata overrides by exact catalog ID, defaults to `{}` |

To store the key in this file, use `apiKey` instead of `apiKeyEnv`:

```json
{
  "servers": [
    {
      "id": "llama-swap-local",
      "baseUrl": "http://127.0.0.1:8080",
      "apiKey": "YOUR_API_KEY"
    }
  ]
}
```

The key is literal. Dollar signs and command-like strings do not expand or execute.
An empty, blank, non-string, or ASCII-control-bearing `apiKey` fails validation.
Do not specify both `apiKey` and `apiKeyEnv`.
This is plaintext storage, like an API-key entry in `auth.json`.
Keep the file private, for example with `chmod 600 /path/to/llama-swap.json`, and do not commit it.
The extension does not change file permissions or copy the key into `auth.json`.

Use HTTPS for credentials outside a trusted private network.
A configured but missing or empty environment key leaves that provider unavailable.
A keyless servers entry uses the non-secret placeholder `local`.
Stored Pi API-key credentials take precedence during runtime authentication and refresh.
A blank stored credential leaves the provider unavailable. It does not fall back to the configuration key.
Startup discovery uses the configuration key or environment key, not Pi's stored credentials.
No environment lookup is needed when `apiKey` is configured.
If startup discovery fails, use `/llama-swap refresh` after resolving authentication.
The extension does not add a `/login` flow.
Changes to the configuration key require `/reload`.

For a server with an untrusted certificate, set `tlsVerify` to `false` in that server entry:

```json
{
  "id": "llama-swap-lan",
  "baseUrl": "https://192.168.1.50:8082",
  "tlsVerify": false
}
```

Add this setting to the existing entry. Keep its credential fields unchanged, then run `/reload`.
This disables certificate and hostname verification for extension-owned HTTPS requests to that server origin only.
It applies to discovery, chat, and classification. Other servers keep their TLS policy.
It does not disable encryption, but an attacker can impersonate that server and read credentials or prompts.
The insecure transport rejects redirects and compressed responses. It requests uncompressed response bodies.
A caller-supplied `fetch` owns its transport policy instead.
Omission means `true`. Null and non-boolean values are invalid.

The legacy single-server object also accepts `api`, `tlsVerify`, and `loadTimeoutMs`, with the same defaults and validation.
`loadTimeoutMs` must be an integer from 1 to 2147483647 milliseconds.
It defaults to provider ID `llama-swap` and, without `apiKey`, environment variable `LLAMA_SWAP_API_KEY`.
Use the servers format for an explicitly keyless server.

## Model metadata

The extension reads `GET <root>/v1/models`. Discovery does not load or probe upstream models.
llama-swap loads the requested model on demand and can unload another model.
It learns capabilities after a model loads and caches them after unloading.
The runtime context can change on each load when the backend fits it to available memory.
The listing reports the last discovered runtime window, not the theoretical model limit.
See upstream [capabilities and model listings](https://github.com/mostlygeek/llama-swap/blob/main/docs/kb/guides/model-runtime/capabilities-and-model-listings.md).

Pi requires a numeric context window before a model enters its catalog.
Unknown models appear with `[context pending]` and a 32768-token placeholder. That number is not a verified limit.
Discovery does not load them. Selection, startup, resume, and reload prepare only the active model.
Entries with llama-swap status metadata also require preparation, even when the listing contains cached context.

Preparation loads the selected route with `GET <root>/upstream/<encoded ID>/v1/models`.
For llama.cpp, it reads `/props` on that route and uses `default_generation_settings.n_ctx`, the per-slot runtime window.
It does not use the total context across all slots. Other identified backends must supply fresh context in their upstream listing.
Runtime context and image capability replace provisional metadata before inference. Metadata changes retain the selected identity.
An unknown entry identified as a native classifier leaves `/model` and becomes available through codemode, unless its type is explicitly overridden.

Normal input preparation finishes before Pi checks compaction. Pending or failed preparation blocks input and inference, and cancels compaction summaries.
Pi can perform an initial budget calculation before extension hooks on a custom-message-triggered turn; the compaction hook blocks pending summaries.
Chat dispatch revalidates dynamic metadata on every request. A classifier tool that swaps out chat causes chat preparation before the next-turn budget check.
The fitted window is not treated as permanent.

Each provider entry serializes preparation and inference through the complete response.
Other servers remain independent. Other clients, separate extension instances, and duplicate entries for the same physical server are outside this lease.
Cancellation can stop waiting or network I/O. It does not undo a server-side load or reload the previously active model.
The load deadline covers metadata HTTP and body reads after acquiring the lease. It does not impose an inference deadline.

Older versions or models without discovered capabilities can require verified overrides:

```json
{
  "modelOverrides": {
    "qwen": {
      "fallbackContextWindow": 32768,
      "maxTokens": 8192,
      "reasoning": false
    },
    "decision-alias": {
      "type": "classifier",
      "contextWindow": 32768,
      "upstreamModelId": "actual-gguf-model-id"
    },
    "embedding-model": {
      "type": "ignore"
    }
  }
}
```

The optional override type is `chat`, `classifier`, or `ignore`.
Otherwise, `architecture.output_modalities` containing `decisions` selects a classifier.
Text output or absent output metadata selects chat. Other advertised output types are ignored.
An absent output type is not proof of chat compatibility. Override non-chat entries on older servers.

Context limit precedence:

1. `contextWindow` override.
2. First positive integer in `context_length`, `context_window`, or `meta.n_ctx`.
3. `fallbackContextWindow` override.

4. A marked 32768-token placeholder when context is still unknown.

For a dynamically prepared model, `contextWindow` is a ceiling on the fresh runtime window, not a replacement for it.
`fallbackContextWindow` only supplies catalog metadata; it cannot replace missing runtime metadata during preparation.
Failed preparation sends no inference. Select another model or retry after correcting the server.
A failed refresh keeps the last published catalog for that process.
Catalogs are not saved across restarts.

Each server selects its chat API with `api`. Omission uses `openai-completions` and sends requests to `<root>/v1/chat/completions`.
Set `api` to `openai-responses` to use Pi's Responses adapter at `<root>/v1/responses`.
The backend must support the selected protocol, including its tool-call format. The extension does not fall back to another API.
Different server entries can use different APIs. API selection does not change discovery, preparation, or native classifier routes.
Only the two exact API names are valid. Null, blank strings, and non-string values fail validation.
Model overrides cannot select an API. Change the provider entry, then run `/reload`.

Responses requests respect the caller limit, model output ceiling, and resolved context window.
Pi 1.2.0 raises Responses output limits below 16 tokens to 16. The extension blocks budgets below 16 instead of exceeding them.
Missing or invalid output budgets also fail before inference. Completion requests retain their existing small-budget behavior.
Caller payload replacements can change these limits and remain caller-owned.
Chat output never exceeds the context limit. Reasoning defaults to false.
Image input requires advertised image capability.
The extension reports token usage when the backend supplies it.
Prices are zero because the discovery response does not establish billing prices.

For `openai-completions`, supported `compat` fields are `supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, and `maxTokensField`.
The last field accepts `max_tokens` or `max_completion_tokens`.
For `openai-responses`, only the shared `supportsDeveloperRole` field is supported. Completion-only fields fail validation.
Set compatibility flags only after verifying your backend.

## Native classifiers

Only native System One classifiers are supported. Chat-as-classifier and reranker adapters are not included.

Classifier calls use `<root>/upstream/<encoded catalog ID>/v1/systemone`.
This route pins the configured llama-swap model.
Before each POST, the extension requires one upstream `/v1/models` entry matching the expected upstream ID.
The classifier response must report that same model ID.
Without `upstreamModelId`, the expected ID is the catalog ID.
Use the override when llama-swap's public alias differs from the backend's model ID.
The returned Pi result retains the public catalog ID.

Classification can load the selected model and trigger llama-swap's configured swapping behavior.
It is not a read-only discovery operation.
Classifier calls prohibit redirects and automatic retries.
Caller cancellation and the caller's optional `timeoutMs` cover the complete call.
Without a caller deadline, the extension limits dynamic preparation with `loadTimeoutMs`, but adds no inference deadline.
Discovery's `timeoutMs` does not limit classification.

Example codemode script:

```js
const classifiers = await models.getAvailableOfType("classifier", "llama-swap-local");
return classifiers.map(model => ({ provider: model.provider, id: model.id }));
```

```js
const judge = await models.getModelOfType("classifier", "llama-swap-local", "judge");
if (!judge) return "Classifier unavailable";
const result = await models.classify(judge, {
  state: { message: "The change works." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the message approve the change?",
      criteria: { true: "Approval", false: "No approval" }
    }
  }
});
return result.stopReason === "stop" ? result.answers : result.errorMessage;
```

## Failure behavior

Discovery, preparation, and classifier JSON responses have a 2 MiB byte limit.
A discovery catalog has at most 1000 entries.
Malformed metadata, duplicate IDs, unexpected classifier identities, and cancelled calls fail without guessed capabilities.
Classifier failures use fixed messages instead of raw server errors.
Other servers can still refresh successfully.
`PI_OFFLINE=1` disables discovery, but it does not disable explicit inference calls.

The generated contract is in [docs/pi-llama-swap.md](docs/pi-llama-swap.md).
The workspace documentation store owns that file. Do not edit it directly.

## Verify

Use the host-supplied Pi packages. Do not bundle a second Pi runtime.
Dynamic preparation is validated with Pi 1.2.0. Older versions have not been checked for this behavior.
Validation uses Node 24 and the installed TypeScript compiler.

```sh
npm run verify
```

The project uses Node's built-in test runner. It has no runtime dependencies.
The package loader test uses the installed Pi loader with a private temporary agent directory.

### Acceptance results

Validation on Pi 1.1.0 and Node 24.21.0 passed TypeScript checks and 36 tests.
The supplied base passed 11 preservation checks and failed 10 adaptation checks before implementation.
A later invalid-deadline regression failed before its fix and passed afterward.
Seven additional verification checks cover package loading, deadlines, body bounds, alias encoding, and cross-server requests.
For literal configuration keys, the original 29 tests passed before the change.
Six new checks failed because `apiKey` was unsupported. One invalid-input check passed before the change.
All seven configuration-key checks passed after implementation.

| Criterion | Before adaptation | Final result |
| --- | --- | --- |
| AC-CONFIG | 2 preservation passes, 2 adaptation failures | 4 tests passed |
| AC-CATALOG | 2 preservation passes, 1 adaptation failure | 3 tests passed |
| AC-REFRESH | 3 preservation passes, 2 adaptation failures | 7 tests passed |
| AC-CLASSIFY | 2 preservation passes, 3 adaptation failures, then 1 deadline regression failure | 10 tests passed |
| AC-ENTRY | 2 preservation passes, 2 adaptation failures | 5 tests passed |
| AC-INLINE-KEY-1 | 1 changed-behavior failure, 1 invalid-input pass | 2 tests passed |
| AC-INLINE-KEY-2 | 3 changed-behavior failures | 3 tests passed |
| AC-INLINE-KEY-3 | 2 changed-behavior failures | 2 tests passed |

The TLS change was checked with Pi 1.2.0 and Node 24.21.0.
`npm run verify` passed TypeScript checks and 44 tests.
AC-TLS-1 and AC-TLS-2 checks failed before implementation, then passed.
The AC-TLS-3 secure-default check and all 36 existing checks passed before and after implementation.
An invalid-status callback regression also failed before its fix, then passed.
The TLS tests use disposable self-signed HTTPS fixtures. They require `openssl` on PATH.
They cover incremental chat, classification, origin isolation, redirects, cancellation, encoded responses, and metadata bounds.

The dynamic-context change passed TypeScript checks and all 72 tests on Pi 1.2.0.
The initial 15 bootstrap checks failed before implementation. The missing-context rejection was replaced by the marked-placeholder acceptance check.
Later image-capability, concurrent-refresh, direct-static-call, and pending-copy regressions failed before their fixes.
The SDK tests cover startup, resume, reload, selection, failed input, custom turns, and classifier-tool continuation.
They observe fitted metadata before the next-turn budget check and before a persisted compaction summary.
Request checks cover refitting, context ceilings, aliases, cancellation, deadlines, complete-response leases, caller transports, and credential isolation.

The provider API selection change passed TypeScript checks and all 89 tests on Pi 1.2.0.
The first 12 changed-behavior checks failed before implementation. Three preservation checks passed before and after implementation.
Two additional regressions exposed stale API annotations and invalid static output budgets. Both failed before their fixes and passed afterward.
Tests cover both config formats, mixed providers, both stream entrypoints, request hooks, tools, usage, dynamic context, cancellation, and output limits.

| Criterion | Before implementation | Final result |
| --- | --- | --- |
| AC-API-1 | 3 changed-behavior failures | 3 tests passed |
| AC-API-2 | 5 changed-behavior failures, then 1 annotation regression failure | 6 tests passed |
| AC-API-3 | 3 changed-behavior failures | 3 tests passed |
| AC-API-4 | 3 preservation passes and 72 existing passes | 75 tests passed |
| AC-API-5 | 2 changed-behavior failures, then 1 invalid-budget regression failure | 3 tests passed |

The mixed-provider test covers AC-API-1 and AC-API-2, so the table counts it in both rows.
These checks use synthetic discovery, SSE chat, and System One responses with the installed Pi adapters.
They do not establish live model compatibility, classifier accuracy, or server swapping behavior.
The unrelated profile-extension check scripts were not run because this task did not change those extensions.
