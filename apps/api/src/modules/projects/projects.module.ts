import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Module({ imports: [OrganizationsModule], controllers: [ProjectsController], providers: [ProjectsService], exports: [ProjectsService] })
export class ProjectsModule {}
