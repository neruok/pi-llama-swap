import { dynamicFixture } from "./dynamic-fixture.mjs";

export const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
export function responseEvents({ tool = false } = {}) {
  const item = tool
    ? { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "" }
    : { id: "msg_fixture", type: "message", role: "assistant", content: [], status: "in_progress" };
  const done = tool ? { ...item, arguments: '{"query":"hello"}', status: "completed" }
    : { ...item, content: [{ type: "output_text", text: "hello", annotations: [] }], status: "completed" };
  return [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item },
    tool ? { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"query":"hello"}' }
      : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" },
    { type: "response.output_item.done", output_index: 0, item: done },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [done],
      usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9, input_tokens_details: { cached_tokens: 3 } } } },
  ];
}
export function responsesFixture(ids = ["a", "b"]) {
  const state = dynamicFixture(ids);
  const metadataFetch = state.fetch;
  state.holdResponse = false;
  state.toolResponse = false;
  state.failResponse = false;
  state.cancelResponse = false;
  state.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith("/responses")) return metadataFetch(input, init);
    state.calls.push({ path: url.pathname, key: new Headers(init.headers).get("authorization"), signal: init.signal, body: init.body });
    if (state.failResponse) return Response.json({ error: { message: "synthetic unsupported Responses" } }, { status: 404 });
    const events = responseEvents({ tool: state.toolResponse });
    const headers = { "content-type": "text/event-stream" };
    if (!state.holdResponse) return new Response(events.map(frame).join(""), { headers });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events.slice(0, 3).map(frame).join("")));
        state.releaseResponse = () => {
          controller.enqueue(new TextEncoder().encode(events.slice(3).map(frame).join("")));
          controller.close();
        };
        init.signal?.addEventListener("abort", () => { state.cancelResponse = true; controller.error(new Error("aborted")); }, { once: true });
      },
      cancel() { state.cancelResponse = true; },
    }), { headers });
  };
  return state;
}
