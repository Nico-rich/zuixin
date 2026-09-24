/** Token 估算抽象（后续可替换为真实 tokenizer；P6 用确定性启发式） */
export interface TokenEstimator {
  estimate(text: string): number;
}

/**
 * 确定性启发式估算（不调用 LLM、无网络请求）：
 * - CJK 字符 ≈ 1.5 tokens/字（保守高估，防止预算爆表）
 * - 非 CJK ≈ 4 字符/token
 * 同一输入永远同一输出；真实 tokenizer 接入时整体替换，算法不散落他处。
 */
export class SimpleTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    if (!text) return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      const isCjk = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff);
      if (isCjk) cjk++;
      else if (ch.trim()) other++;
    }
    return Math.ceil(cjk / 1.5) + Math.ceil(other / 4);
  }
}
