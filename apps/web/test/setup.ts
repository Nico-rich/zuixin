import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// globals:false —— RTL 的自动 cleanup 依赖全局 afterEach，这里显式注册
afterEach(() => cleanup());

// jsdom 未实现 Element.prototype.scrollTo（聊天页自动滚动会调用）
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => undefined;
}

// jsdom 未实现 matchMedia（lucide/主题相关组件可能探测）
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// 每个用例后清掉模块级缓存之外的残留（测试用 fetch 一律显式 mock）
afterEach(() => vi.unstubAllGlobals());
