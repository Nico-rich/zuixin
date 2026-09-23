import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

@Global()
@Module({
  providers: [{ provide: CryptoService, useFactory: () => new CryptoService(process.env.ENCRYPTION_KEY ?? '') }],
  exports: [CryptoService],
})
export class CryptoModule {}
