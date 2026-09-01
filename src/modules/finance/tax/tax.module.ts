import { Global, Module } from '@nestjs/common';
import { StatutoryTaxService } from './statutory-tax.service';
import { TaxController } from './tax.controller';

/**
 * Global because both payroll engines depend on it and neither should have to
 * import a module to get the same tax answer as the other — that divergence is
 * what F-16 was.
 */
@Global()
@Module({
  controllers: [TaxController],
  providers: [StatutoryTaxService],
  exports: [StatutoryTaxService],
})
export class TaxModule {}
