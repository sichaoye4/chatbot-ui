import { readFileSync } from 'node:fs';
import type { PlanningModel } from '../foundation.ts';

export type DeepSeekConfiguration = {
  baseUrl: string;
  model: string;
  key: () => string | undefined;
};
export function deepSeekConfiguration(): DeepSeekConfiguration {
  return {
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    key: () => {
      if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
      const path = process.env.DEEPSEEK_API_KEY_FILE;
      return path ? readFileSync(path, 'utf8').trim() : undefined;
    },
  };
}
export class DeepSeekPlanningModel implements PlanningModel {
  readonly calls: { model: string; returnedModel?: string; latencyMs: number; tokens?: number }[] =
    [];
  constructor(
    private readonly configuration = deepSeekConfiguration(),
    private readonly request: typeof fetch = fetch,
  ) {
    const url = new URL(configuration.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('PROVIDER_URL_INVALID');
  }
  async complete(input: Parameters<PlanningModel['complete']>[0]): Promise<unknown> {
    input.signal.throwIfAborted();
    const key = this.configuration.key();
    if (!key) throw new Error('PROVIDER_NOT_CONFIGURED');
    const started = performance.now();
    const response = await this.request(
      `${this.configuration.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(120000)]),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.configuration.model,
          temperature: 0,
          max_tokens: 16000,
          stream: false,
          thinking: { type: process.env.DEEPSEEK_THINKING === 'disabled' ? 'disabled' : 'enabled' },
          messages: [
            { role: 'system', content: input.instructions },
            { role: 'user', content: input.context },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'present_response',
                description: 'Present a complete capability-validated response plan',
                parameters: input.schema,
              },
            },
          ],
          // Thinking mode accepts automatic tool selection; a forced function is rejected.
          // The response is still required to contain exactly the presentation tool call below.
          tool_choice: 'auto',
        }),
      },
    );
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    const body = (await response.json()) as {
      model?: string;
      usage?: { total_tokens?: number };
      choices?: {
        message?: { tool_calls?: { function: { name: string; arguments: string } }[] };
      }[];
    };
    this.calls.push({
      model: this.configuration.model,
      returnedModel: body.model,
      latencyMs: Math.round(performance.now() - started),
      tokens: body.usage?.total_tokens,
    });
    const calls = body.choices?.[0]?.message?.tool_calls;
    if (calls?.length !== 1 || calls[0].function.name !== 'present_response')
      throw new Error('PROVIDER_INVALID_RESPONSE');
    try {
      return JSON.parse(calls[0].function.arguments);
    } catch {
      throw new Error('PROVIDER_INVALID_JSON');
    }
  }
}
