import { Global, Module } from '@nestjs/common';
import { RouterService } from './router.service';

@Global()
@Module({ providers: [RouterService], exports: [RouterService] })
export class RouterModule {}
