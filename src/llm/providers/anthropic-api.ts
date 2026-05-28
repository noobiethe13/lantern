import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { classifyErrorMessage, LlmError } from '../provider';
import type { HealthcheckResult, LlmProvider, LlmRequest, LlmTask } from '../provider';
import { zodToProviderSchema } from '../zod-to-schema';

type ClaudeModel =
  | 'claude-opus-4-5'
  | 'claude-sonnet-4-5'
  | 'claude-haiku-4-5';

const TASK_MODELS: Record<LlmTask, ClaudeModel> = {
  verdict: 'claude-sonnet-4-5',
  'nl-filter': 'claude-haiku-4-5',
  'html-extract': 'claude-sonnet-4-5',
  'hn-extract': 'claude-haiku-4-5',
};

// Force the model into a structured output by giving it exactly one tool and
// requiring its use. The tool's `input_schema` is the zod schema we want.
// content[0].input is the resulting validated object.
const STRUCTURED_TOOL_NAME = 'emit_result';
const STRUCTURED_TOOL_DESC = 'Emit the result conforming to the provided schema.';

const STRICT_SUFFIX =
  '\n\nIMPORTANT: Call the emit_result tool with a value matching its input_schema. Do not respond with prose.';

const MAX_TOKENS = 4096;

export class AnthropicApiProvider implements LlmProvider {
  readonly name = 'anthropic-api' as const;

  constructor(private readonly apiKey: string) {}

  defaultModelFor(task: LlmTask): string {
    return TASK_MODELS[task];
  }

  async call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
    if (!this.apiKey) {
      throw new LlmError('fatal', 'anthropic-api: no API key configured (Settings → LLM → Anthropic API key)');
    }

    const modelName = (req.modelOverride ?? this.defaultModelFor(req.task)) as ClaudeModel;
    const client = new Anthropic({ apiKey: this.apiKey });
    const inputSchema = zodToProviderSchema(schema) as Anthropic.Tool.InputSchema;

    const generate = async (prompt: string): Promise<unknown> => {
      const res = await client.messages.create({
        model: modelName,
        max_tokens: MAX_TOKENS,
        tools: [{ name: STRUCTURED_TOOL_NAME, description: STRUCTURED_TOOL_DESC, input_schema: inputSchema }],
        tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
        messages: [{ role: 'user', content: prompt }],
      });
      const block = res.content.find(b => b.type === 'tool_use' && b.name === STRUCTURED_TOOL_NAME);
      if (!block || block.type !== 'tool_use') {
        throw new Error(`anthropic-api: no tool_use block returned (stop_reason=${res.stop_reason})`);
      }
      return block.input;
    };

    try {
      const raw = await generate(req.prompt);
      const first = schema.safeParse(raw);
      if (first.success) return first.data;
      console.warn(`[anthropic-api] first-attempt schema error: ${first.error.message}`);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[anthropic-api] first-attempt failed: ${msg}`);
      if (classifyErrorMessage(msg) === 'fatal') {
        throw new LlmError('fatal', `anthropic-api: ${msg}`);
      }
    }

    try {
      const strict = await generate(req.prompt + STRICT_SUFFIX);
      return schema.parse(strict);
    } catch (err) {
      const msg = (err as Error).message;
      throw new LlmError(classifyErrorMessage(msg), `anthropic-api: ${msg}`);
    }
  }

  async healthcheck(): Promise<HealthcheckResult> {
    try {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { ok: true, detail: 'anthropic-api: API key accepted' };
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        detail: `anthropic-api: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}`,
      };
    } catch (err) {
      return { ok: false, detail: `anthropic-api: ${(err as Error).message}` };
    }
  }
}
