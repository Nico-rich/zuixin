import { Injectable } from '@nestjs/common';
import { Tool } from './tool.types';

@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool 重复注册: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 按 Agent 允许清单取子集（服务端权限边界） */
  listForAgent(allowedNames: string[]): Tool[] {
    return allowedNames.map((n) => this.tools.get(n)).filter((t): t is Tool => !!t);
  }
}
