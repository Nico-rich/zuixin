import { describe, expect, it } from 'vitest';
import { declaresCapabilityKey, modelSupports } from './capability-match';

describe('M8-P7 能力匹配', () => {
  it('类型兜底：llm/image/video/embedding 各自匹配对应能力', () => {
    expect(modelSupports({ id: 'm', type: 'llm', capabilities: {} }, 'text_generation')).toBe(true);
    expect(modelSupports({ id: 'm', type: 'image', capabilities: {} }, 'image_generation')).toBe(true);
    expect(modelSupports({ id: 'm', type: 'video', capabilities: {} }, 'video_generation')).toBe(true);
    expect(modelSupports({ id: 'm', type: 'embedding', capabilities: {} }, 'embedding')).toBe(true);
    expect(modelSupports({ id: 'm', type: 'image', capabilities: {} }, 'text_generation')).toBe(false);
  });

  it('显式声明类能力（function_calling/vision）只认声明，llm 类型不等于会调工具/能读图', () => {
    expect(modelSupports({ id: 'm', type: 'llm', capabilities: {} }, 'function_calling')).toBe(false);
    expect(modelSupports({ id: 'm', type: 'llm', capabilities: {} }, 'vision')).toBe(false);
    expect(modelSupports({ id: 'm', type: 'llm', capabilities: { tools: true } }, 'function_calling')).toBe(true);
    expect(modelSupports({ id: 'm', type: 'llm', capabilities: { vision: true } }, 'vision')).toBe(true);
  });

  it('停用模型一律不支持（即使声明了能力）', () => {
    expect(modelSupports({ id: 'm', type: 'llm', capabilities: { vision: true }, enabled: false }, 'vision')).toBe(false);
  });

  it('declareCapabilityKey 容忍 null/非对象 capabilities', () => {
    expect(declaresCapabilityKey(null, 'vision')).toBe(false);
    expect(declaresCapabilityKey('vision', 'vision')).toBe(false);
    expect(declaresCapabilityKey({ imageInput: true }, 'vision')).toBe(true);
  });
});
