// Compatibility interface for the v1 runtime. Domain implementations live in examples.
import type { Artifact, Plan } from '../contracts/index.ts';
import type { Principal } from '../catalog/index.ts';
import type { QueryRuntime } from '../server-runtime/queries.ts';
export type Response =
  | { kind: 'clarification'; text: string }
  | { kind: 'visual'; plan: Plan }
  | { kind: 'facts'; toolId: string; args: Record<string, unknown>; fields: string[] }
  | { kind: 'explain'; reason: string };
export type AgentContext = {
  text: string;
  previous?: Artifact;
  principal: Principal;
  queries: QueryRuntime;
  signal: AbortSignal;
};
export type Agent = {
  mode: string;
  calls: { model: string; returnedModel?: string; latencyMs: number; tokens?: number }[];
  run(context: AgentContext): Promise<Response>;
};
export { CapabilityPlanningAgent, type PlanningModel } from './foundation.ts';
