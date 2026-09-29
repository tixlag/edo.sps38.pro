import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AccessRuleGuard } from './access-rule.guard';
import { JwtService } from './jwt.service';

@Module({
  providers: [
    JwtService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AccessRuleGuard },
  ],
  exports: [JwtService],
})
export class AuthModule {}
