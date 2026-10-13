import { listing, json, chat, answers } from "./helpers.mjs";

export function dynamicFixture(ids = ["a", "b"]) {
  const state = {
    entries: ids.map(id => ({ id, name: id, status: { value: "unloaded" } })),
    windows: Object.fromEntries(ids.map(id => [id, 65536])),
    types: {}, aliases: {}, images: {}, advertisedImages: {}, owners: {}, nativeContexts: {}, calls: [], loaded: undefined,
    failProps: false, pendingProps: false, holdChat: false, toolCallOnce: false,
    releaseChat: undefined, cancelBody: false,
  };
  state.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = new Headers(init.headers).get("authorization");
    state.calls.push({ path: url.pathname, key, signal: init.signal, body: init.body });
    if (url.pathname.endsWith("/upstream/a/v1/models") || /\/upstream\/[^/]+\/v1\/models$/u.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-3));
      state.loaded = id;
      return json(listing({ id: state.aliases[id] ?? id, owned_by: state.owners[id] ?? "llamacpp", context_length: state.nativeContexts[id], meta: { n_ctx: 262144 },
        architecture: { input_modalities: state.advertisedImages[id] ? ["text", "image"] : ["text"],
          output_modalities: [state.types[id] === "classifier" ? "decisions" : "text"] } }));
    }
    if (/\/upstream\/[^/]+\/props$/u.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-2));
      if (state.failProps) return json({ private: "synthetic-private-body" }, 500);
      if (state.pendingProps) return new Response(new ReadableStream({ cancel() { state.cancelBody = true; } }));
      return json({ default_generation_settings: { n_ctx: state.windows[id] }, modalities: { vision: state.images[id] ?? false } });
    }
    if (url.pathname.endsWith("/systemone")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-3));
      return json({ model: state.aliases[id] ?? id, answers, usage: { input_tokens: 2, output_tokens: 1 } });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const toolCall = state.toolCallOnce; state.toolCallOnce = false;
      const chunk = { id: "dynamic-chat", object: "chat.completion.chunk", created: 1,
        model: JSON.parse(init.body).model, choices: [{ index: 0,
          delta: toolCall ? { tool_calls: [{ index: 0, id: "synthetic-judge-call", type: "function",
            function: { name: "dynamic_judge", arguments: "{}" } }] } : { content: "hello" },
          finish_reason: toolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: toolCall ? 40000 : 2, completion_tokens: 1, total_tokens: toolCall ? 40001 : 3 } };
      const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
      if (!state.holdChat) return new Response(body, { headers: { "content-type": "text/event-stream" } });
      return new Response(new ReadableStream({
        start(controller) { state.releaseChat = () => { controller.enqueue(new TextEncoder().encode(body)); controller.close(); }; },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/v1/models")) return json(listing(...state.entries));
    throw new Error("Unexpected synthetic request: " + url.pathname);
  };
  return state;
}
export const transcript = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
export const apiModel = (provider, id = "a") => ({ ...chat(id), type: "chat", api: "openai-completions", provider,
  name: id, baseUrl: "https://swap.invalid/prefix/v1", input: ["text"], contextWindow: 32768, maxTokens: 4096,
  reasoning: false, contextPending: true, dynamicContext: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
