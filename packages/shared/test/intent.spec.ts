import { describe, it, expect } from 'vitest';
import { TaskIntentSchema } from '../src';

describe('TaskIntentSchema', () => {
  const valid = {
    type: 'image_generation', confidence: 0.98,
    parameters: { prompt: '科技感智能插排广告图', aspectRatio: '1:1' },
  };

  it('解析合法意图', () => {
    expect(TaskIntentSchema.parse(valid)).toEqual(valid);
  });

  it('拒绝未知意图类型', () => {
    expect(() => TaskIntentSchema.parse({ ...valid, type: 'sing_a_song' })).toThrow();
  });

  it('confidence 越界报错', () => {
    expect(() => TaskIntentSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
    expect(() => TaskIntentSchema.parse({ ...valid, confidence: -0.1 })).toThrow();
  });

  it('parameters.prompt 必填', () => {
    expect(() => TaskIntentSchema.parse({ type: 'chat', confidence: 0.9, parameters: {} })).toThrow();
  });
});
