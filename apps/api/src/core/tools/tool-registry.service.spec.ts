import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './tool-registry.service';
import { Tool } from './tool.types';

function makeTool(name: string): Tool {
  return {
    name, description: 'x', permission: 'read',
    inputSchema: z.object({ a: z.string() }),
    execute: async () => ({ ok: true }),
  };
}

describe('ToolRegistry', () => {
  it('register/get/list/has/unregister 全流程', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('image.generate'));
    expect(registry.has('image.generate')).toBe(true);
    expect(registry.get('image.generate')?.name).toBe('image.generate');
    expect(registry.list().length).toBe(1);
    registry.unregister('image.generate');
    expect(registry.has('image.generate')).toBe(false);
  });

  it('重复注册同名 Tool 报错', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('x.y'));
    expect(() => registry.register(makeTool('x.y'))).toThrow('重复注册');
  });

  it('listForAgent：按允许清单取子集，未注册名被过滤（服务端权限边界）', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('image.generate'));
    registry.register(makeTool('video.generate'));
    const subset = registry.listForAgent(['image.generate', 'not.exists', 'video.generate']);
    expect(subset.map((t) => t.name)).toEqual(['image.generate', 'video.generate']);
  });
});
