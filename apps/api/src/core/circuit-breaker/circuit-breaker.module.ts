import { Global, Module } from '@nestjs/common';
import { RedisKVService } from './redis-kv.service';
import { CircuitBreakerService } from './circuit-breaker.service';

@Global()
@Module({
  providers: [
    RedisKVService,
    { provide: CircuitBreakerService, useFactory: (kv: RedisKVService) => new CircuitBreakerService(kv), inject: [RedisKVService] },
  ],
  exports: [RedisKVService, CircuitBreakerService],
})
export class CircuitBreakerModule {}
