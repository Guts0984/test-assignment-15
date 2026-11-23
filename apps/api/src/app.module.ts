import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AuthGuard } from './common/auth/auth.guard';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { env as appEnv, type Env } from './config/env';
import { InfraModule } from './infra/infra.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { ShiftsModule } from './modules/shifts/shifts.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { PortalModule } from './modules/portal/portal.module';
import { PublicFormModule } from './modules/public-form/public-form.module';
import { SurveysModule } from './modules/surveys/surveys.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { TestControlModule } from './modules/test-control/test-control.module';
import { TimeModule } from './modules/time/time.module';

@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {
  static register(env: Env = appEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.register(env),
        AuthModule,
        AdminModule,
        ShiftsModule,
        TicketsModule,
        InboundModule,
        PublicFormModule,
        PortalModule,
        SurveysModule,
        TimeModule,
        ...(env.TEST_CLOCK_ENABLED ? [TestControlModule] : []),
      ],
    };
  }
}
