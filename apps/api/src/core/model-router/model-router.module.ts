import { Module } from '@nestjs/common';
import { ModelRouterService } from './model-router.service';
import { CircuitBreakerService } from '../circuit-breaker/circuit-breaker.service';

@Module({
  providers: [
    {
      provide: ModelRouterService,
      useFactory: (cb: CircuitBreakerService) => new ModelRouterService(cb),
      inject: [CircuitBreakerService],
    },
  ],
  exports: [ModelRouterService],
})
export class ModelRouterModule {}
