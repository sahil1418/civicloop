import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ChatMessageDto } from './chatbot.dto';
import {
  CHATBOT_LINKS,
  CHATBOT_SUGGESTIONS,
  CHATBOT_SYSTEM_PROMPT,
} from './chatbot.knowledge';
import { CHATBOT_TOOLS, ChatbotRetrieval } from './chatbot.retrieval';
import type { ChatSource } from './chatbot.retrieval';
import type { ChatActor } from './chatbot.identity';

const ToolCall = z.object({
  id: z.string().min(1).max(100),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(80),
    arguments: z.string().max(3000),
  }),
});
type ToolCallValue = z.infer<typeof ToolCall>;
interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallValue[];
  tool_call_id?: string;
}
const Completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().max(2000).nullable().optional(),
          tool_calls: z.array(ToolCall).min(1).max(3).optional(),
        }),
      }),
    )
    .min(1),
});

@Injectable()
export class ChatbotService {
  private inFlight = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly retrieval: ChatbotRetrieval,
  ) {}

  private settings() {
    if (this.config.get<string>('CHATBOT_ENABLED') !== 'true') return null;
    const key = this.config.get<string>('CHATBOT_API_KEY')?.trim();
    const model = this.config.get<string>('CHATBOT_MODEL')?.trim();
    const base = this.config.get<string>('CHATBOT_API_BASE_URL')?.trim();
    if (!key || !model || !base) return null;
    try {
      const url = new URL(base);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
        return null;
      if (url.username || url.password || url.search || url.hash) return null;
      const timeout = Number(
        this.config.get<string>('CHATBOT_TIMEOUT_MS') ?? '15000',
      );
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30000)
        return null;
      return {
        key,
        model,
        endpoint: `${base.replace(/\/+$/, '')}/chat/completions`,
        timeout,
      };
    } catch {
      return null;
    }
  }

  status(actor?: ChatActor) {
    const enabled = this.settings() !== null;
    return {
      enabled,
      message: enabled
        ? 'Ask about ward performance or sign in to retrieve your own complaint statuses.'
        : 'Chat is currently unavailable. You can still use the helpful pages below.',
      suggestions: actor
        ? [
            'What is the status of my complaints?',
            'Compare performance across two wards',
            'How do I report an issue?',
          ]
        : CHATBOT_SUGGESTIONS,
      signedIn: !!actor,
      links: CHATBOT_LINKS,
    };
  }

  async reply(messages: ChatMessageDto[], actor?: ChatActor) {
    const settings = this.settings();
    if (!settings)
      throw new ServiceUnavailableException('Chat is currently unavailable.');
    if (
      messages.length < 1 ||
      messages.length > 9 ||
      messages.length % 2 !== 1 ||
      messages.some(
        (m, i) => m.role !== (i % 2 === 0 ? 'user' : 'assistant'),
      ) ||
      messages.reduce((size, m) => size + m.content.length, 0) > 10000
    ) {
      throw new BadRequestException(
        'Send a short conversation ending with your question.',
      );
    }
    if (this.inFlight >= 4) {
      throw new ServiceUnavailableException(
        'The guide is busy. Please try again shortly.',
      );
    }
    this.inFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeout);
    try {
      const conversation: ModelMessage[] = [
        {
          role: 'system',
          content: `${CHATBOT_SYSTEM_PROMPT}\nCurrent UTC time: ${new Date().toISOString()}. User signed in: ${!!actor}.`,
        },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      const sources: ChatSource[] = [];
      const trace: string[] = [];
      let calls = 0;
      for (let round = 0; round < 4; round++) {
        if (controller.signal.aborted) throw new Error('Timeout');
        const result = await this.complete(
          settings,
          conversation,
          controller.signal,
          round === 0,
        );
        if (result.tool_calls?.length) {
          calls += result.tool_calls.length;
          if (
            calls > 6 ||
            result.tool_calls.some(
              (t) =>
                !CHATBOT_TOOLS.some(
                  (allowed) => allowed.function.name === t.function.name,
                ),
            )
          )
            throw new Error('Tool budget or allowlist violation');
          conversation.push({
            role: 'assistant',
            content: null,
            tool_calls: result.tool_calls,
          });
          for (const call of result.tool_calls) {
            if (controller.signal.aborted) throw new Error('Timeout');
            const args: unknown = JSON.parse(call.function.arguments);
            const retrieved = await this.retrieval.execute(
              call.function.name,
              args,
              actor,
            );
            if (controller.signal.aborted) throw new Error('Timeout');
            trace.push(call.function.name);
            const sourceId = retrieved.source
              ? `S${sources.length + 1}`
              : undefined;
            if (retrieved.source)
              sources.push({ ...retrieved.source, id: sourceId! });
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ ...retrieved, sourceId }),
            });
          }
          continue;
        }
        const answer = result.content?.trim();
        const citations = [...(answer?.matchAll(/\[S(\d+)\]/g) ?? [])].map(
          (m) => `S${m[1]}`,
        );
        if (
          !answer ||
          !calls ||
          (sources.length && !citations.length) ||
          citations.some((id) => !sources.some((source) => source.id === id))
        )
          throw new Error('Ungrounded answer');
        return {
          message: answer,
          links: CHATBOT_LINKS,
          sources,
          retrievedWith: [...new Set(trace)],
        };
      }
      throw new Error('Retrieval step budget exceeded');
    } catch {
      if (controller.signal.aborted) {
        throw new GatewayTimeoutException(
          'The guide took too long to reply. Please try again.',
        );
      }
      throw new ServiceUnavailableException(
        'The guide could not retrieve a grounded reply. Please try again shortly.',
      );
    } finally {
      clearTimeout(timer);
      this.inFlight--;
    }
  }

  private async complete(
    settings: NonNullable<ReturnType<ChatbotService['settings']>>,
    messages: ModelMessage[],
    signal: AbortSignal,
    requireTool: boolean,
  ) {
    const response = await fetch(settings.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${settings.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        tools: CHATBOT_TOOLS,
        tool_choice: requireTool ? 'required' : 'auto',
        max_tokens: 600,
        stream: false,
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Provider unavailable');
    }
    // Bound the response before parsing, even if Content-Length is absent.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          throw new Error('Provider response too large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const parsed = Completion.parse(data);
    return parsed.choices[0].message;
  }
}
