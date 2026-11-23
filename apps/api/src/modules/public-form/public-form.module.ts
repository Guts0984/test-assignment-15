import { Module } from '@nestjs/common';
import { PublicFormController } from './public-form.controller';

@Module({ controllers: [PublicFormController] })
export class PublicFormModule {}
