import { Module } from '@nestjs/common';
import { ContextAssembler } from './context-assembler';

@Module({ providers: [ContextAssembler], exports: [ContextAssembler] })
export class ContextModule {}
