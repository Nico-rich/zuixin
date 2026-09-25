import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OrganizationsApiModule } from '../organizations/organizations-api.module';
import { SecurityModule } from '../security/security.module';

@Global()
@Module({
  imports: [
    OrganizationsModule,
    OrganizationsApiModule,
    SecurityModule, // M8-P8：JwtAuthGuard 的禁用用户阻断 + 会话撤销判定
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'dev-secret',
        signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SEC ?? 900) },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
