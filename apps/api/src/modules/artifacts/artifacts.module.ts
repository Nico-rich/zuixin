import { Module } from '@nestjs/common';
import { ArtifactService } from './artifact.service';

@Module({ providers: [ArtifactService], exports: [ArtifactService] })
export class ArtifactsModule {}
