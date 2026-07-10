import type { ChatRequest } from '../adapters/types';

// Translation between OpenAI's Responses API surface and the internal chat/completions
// (ChatRequest) shape the pool already speaks. This lets any OpenAI-compatible upstream
// serve /v1/responses without itself implementing that endpoint.
//
// Scope (v1): text conversation + function tools + usage. Non-text input parts
// (images, audio) are dropped; reasoning/other item types are ignored. Streaming
// emits real output_text deltas; tool calls are surfaced as whole items at finalize
// (no per-argument delta events).

/** Responses request fields we read; everything else is ignored, not forwarded. */
export interface ResponsesRequest {
  model: string;
  input?: string | any[];
  instructions?: string | null;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: any[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);

function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && TEXT_PART_TYPES.has(p.type))
      .map((p) => p.text ?? '')
      .join('');
  }
  return '';
}

function inputItemToMessages(item: any): any[] {
  if (typeof item === 'string') return [{ role: 'user', content: item }];
  if (!item || typeof item !== 'object') return [];
  if (item.type === 'function_call') {
    return [{
      role: 'assistant', content: null,
      tool_calls: [{
        id: item.call_id ?? item.id, type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '' },
      }],
    }];
  }
  if (item.type === 'function_call_output') {
    const out = item.output;
    return [{ role: 'tool', tool_call_id: item.call_id, content: typeof out === 'string' ? out : JSON.stringify(out ?? '') }];
  }
  if (item.type === 'message' || item.role) {
    return [{ role: item.role ?? 'user', content: partsToText(item.content) }];
  }
  return []; // reasoning / unsupported items dropped
}

function toChatTools(tools: any[]): any[] | undefined {
  const out = tools
    .filter((t) => t && t.type === 'function' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name, description: t.description, parameters: t.parameters,
        ...(t.strict != null ? { strict: t.strict } : {}),
      },
    }));
  return out.length ? out : undefined;
}

function toChatToolChoice(tc: any): any {
  if (tc == null) return undefined;
  if (typeof tc === 'string') return tc; // 'auto' | 'none' | 'required'
  if (tc.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  return tc;
}

/** Responses request -> internal ChatRequest (openai chat/completions shape). */
export function responsesToChat(body: ResponsesRequest): ChatRequest {
  const messages: any[] = [];
  if (typeof body.instructions === 'string' && body.instructions.length) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) messages.push(...inputItemToMessages(item));
  }

  const stream = body.stream === true;
  const chat: any = { model: body.model, messages, stream };
  if (body.temperature != null) chat.temperature = body.temperature;
  if (body.top_p != null) chat.top_p = body.top_p;
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
  if (Array.isArray(body.tools)) { const t = toChatTools(body.tools); if (t) chat.tools = t; }
  const tc = toChatToolChoice(body.tool_choice);
  if (tc !== undefined) chat.tool_choice = tc;
  // ask the upstream to report usage on the final SSE chunk so streamed calls are still costed
  if (stream) chat.stream_options = { include_usage: true };
  return chat as ChatRequest;
}

// ---- response direction: chat/completions -> Responses ----

export interface ResponseCtx {
  id: string;
  createdAt: number; // unix seconds
  model: string;
  echo: {
    temperature: number | null;
    top_p: number | null;
    max_output_tokens: number | null;
    tools: any[];
    tool_choice: any;
    instructions: string | null;
    metadata: Record<string, unknown>;
  };
}

export function toResponsesUsage(u: any): any {
  if (!u) return null;
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: u.total_tokens ?? input + output,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function statusFor(finish: string | undefined): { status: string; incomplete_details: any } {
  if (finish === 'length') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  return { status: 'completed', incomplete_details: null };
}

export function buildResponse(
  ctx: ResponseCtx,
  opts: { output: any[]; usage: any; finish?: string; status?: string }
): any {
  let status: string, incomplete_details: any;
  if (opts.status) { status = opts.status; incomplete_details = null; }
  else { const s = statusFor(opts.finish); status = s.status; incomplete_details = s.incomplete_details; }

  const output_text = opts.output
    .filter((o) => o.type === 'message')
    .flatMap((m) => m.content ?? [])
    .filter((c: any) => c.type === 'output_text')
    .map((c: any) => c.text)
    .join('');

  return {
    id: ctx.id,
    object: 'response',
    created_at: ctx.createdAt,
    status,
    error: null,
    incomplete_details,
    instructions: ctx.echo.instructions,
    max_output_tokens: ctx.echo.max_output_tokens,
    model: ctx.model,
    output: opts.output,
    output_text,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    temperature: ctx.echo.temperature,
    tool_choice: ctx.echo.tool_choice ?? 'auto',
    tools: ctx.echo.tools,
    top_p: ctx.echo.top_p,
    truncation: 'disabled',
    usage: toResponsesUsage(opts.usage),
    metadata: ctx.echo.metadata ?? {},
  };
}

/** Build the `output` array of a completed Responses object from a chat response. */
export function chatChoiceToOutput(chat: any, ids: () => string): any[] {
  const choice = chat?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const output: any[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call', id: 'fc_' + ids(), call_id: tc.id ?? 'call_' + ids(),
        name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '', status: 'completed',
      });
    }
  }
  if (msg.content != null && msg.content !== '') {
    output.push({
      type: 'message', id: 'msg_' + ids(), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: String(msg.content), annotations: [] }],
    });
  }
  return output;
}

// ---- streaming: chat/completions SSE -> Responses SSE ----

/**
 * Transform an upstream chat/completions SSE body into a Responses-API SSE event
 * stream. Accumulates text, tool calls, and usage; `onDone` fires once with the
 * final chat usage (or null) so the caller can log token counts for the stream.
 */
export function chatSseToResponses(
  upstream: ReadableStream<Uint8Array>,
  ctx: ResponseCtx,
  ids: () => string,
  onDone?: (usage: any) => void | Promise<void>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let seq = 0;
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: any) => {
    const payload = JSON.stringify({ type: event, sequence_number: seq++, ...data });
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const msgId = 'msg_' + ids();
      let messageStarted = false;
      let fullText = '';
      let usage: any = null;
      let finish: string | undefined;
      const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();

      emit(controller, 'response.created', { response: buildResponse(ctx, { output: [], usage: null, status: 'in_progress' }) });

      const reader = upstream.getReader();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let chunk: any;
            try { chunk = JSON.parse(payload); } catch { continue; }
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content.length) {
              if (!messageStarted) {
                messageStarted = true;
                emit(controller, 'response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
                emit(controller, 'response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
              }
              fullText += delta.content;
              emit(controller, 'response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: delta.content });
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const acc = toolAcc.get(idx) ?? { args: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
                toolAcc.set(idx, acc);
              }
            }
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }

        const output: any[] = [];
        let outIndex = 0;
        if (messageStarted) {
          emit(controller, 'response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text: fullText });
          emit(controller, 'response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } });
          emit(controller, 'response.output_item.done', { output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } });
          output.push({ type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
          outIndex = 1;
        }
        for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
          const item = { type: 'function_call', id: 'fc_' + ids(), call_id: acc.id ?? 'call_' + ids(), name: acc.name ?? '', arguments: acc.args, status: 'completed' };
          emit(controller, 'response.output_item.added', { output_index: outIndex, item });
          emit(controller, 'response.output_item.done', { output_index: outIndex, item });
          output.push(item);
          outIndex++;
        }
        emit(controller, 'response.completed', { response: buildResponse(ctx, { output, usage, finish }) });
      } catch {
        emit(controller, 'response.failed', { response: buildResponse(ctx, { output: [], usage, status: 'failed' }) });
      } finally {
        controller.close();
        await onDone?.(usage);
      }
    },
  });
}
