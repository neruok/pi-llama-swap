import { createLlamaSwapProvider } from "../llama-swap.ts";
export const config = (overrides = {}) => ({
  id: "llama-swap-test", baseUrl: "https://swap.invalid/prefix",
  timeoutMs: 3000, defaultMaxTokens: 4096, modelOverrides: {}, ...overrides,
});
export const listing = (...data) => ({ data });
export const chat = (id = "chat") => ({ id, context_length: 32768, architecture: { output_modalities: ["text"] } });
export const decision = (id = "judge") => ({ ...chat(id), architecture: { output_modalities: ["decisions"] } });
export const json = (body, status = 200) => Response.json(body, { status });
export const refresh = async (provider, overrides = {}) => {
  const calls = [];
  await provider.refreshModels({
    allowNetwork: true, signal: new AbortController().signal,
    publish: async publication => { calls.push(publication); publication.update?.(); return true; },
    ...overrides,
  });
  return calls;
};
export const context = {
  state: { message: "hello" },
  questions: {
    approved: { type: "bool", instructions: "Approved?", criteria: { true: "yes", false: "no" } },
    category: { type: "choice", instructions: "Category?", criteria: { a: "A", b: "B" } },
    score: { type: "score", instructions: "Score?", criteria: ["low", "high"] },
  },
};
export const answers = {
  approved: { type: "noul", noul: 0.75 },
  category: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 },
  score: { type: "score", score: 0.4, confidence: 0.2 },
};
export async function classifier({ cfg = config(), catalogId = "judge", upstream = catalogId, resultModel = upstream, post, requestOptions = {} } = {}) {
  const calls = [];
  const provider = createLlamaSwapProvider(cfg, async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith(`/upstream/${encodeURIComponent(catalogId)}/v1/models`)) return json(listing({ id: upstream }));
    if (String(url).endsWith("/systemone")) return post?.(url, init) ?? json({
      model: resultModel, answers, usage: { input_tokens: 17, output_tokens: 3 },
    });
    return json(listing(decision(catalogId)));
  });
  await refresh(provider);
  const model = provider.getAllModels()[0];
  const result = await provider.classify(model, context, { apiKey: "synthetic-key", ...requestOptions });
  return { provider, model, result, calls };
}
export function fakePi() {
  const providers = [], commands = new Map(), events = new Map(), messages = [];
  return { providers, commands, events, messages,
    api: {
      registerProvider: p => providers.push(p),
      registerCommand: (name, command) => commands.set(name, command),
      on: (name, callback) => events.set(name, callback),
      sendMessage: (message, options) => messages.push({ message, options }),
    },
  };
}
