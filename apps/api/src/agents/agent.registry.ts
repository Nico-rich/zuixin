import { Injectable } from '@nestjs/common';
import { Agent } from './agent.types';

@Injectable()
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    if (this.agents.has(agent.id)) throw new Error(`Agent 重复注册: ${agent.id}`);
    this.agents.set(agent.id, agent);
  }

  get(id: string): Agent | undefined { return this.agents.get(id); }
  list(): Agent[] { return [...this.agents.values()]; }
}
