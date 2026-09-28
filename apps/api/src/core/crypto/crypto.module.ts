import { Global, Module } from '@nestjs/common';
import { CryptoService, encryptionKeyConfigFromEnv } from './crypto.service';

/**
 * M10-P1 SA-12：密钥配置单点解析（ENCRYPTION_KEYS 多版本，回退 ENCRYPTION_KEY = 版本 1）。
 * 工厂在**模块初始化时**读 env（不是 import 时）——测试/多实例可各自决定配置，且装配失败立即暴露。
 */
@Global()
@Module({
  providers: [{ provide: CryptoService, useFactory: () => new CryptoService(encryptionKeyConfigFromEnv()) }],
  exports: [CryptoService],
})
export class CryptoModule {}
