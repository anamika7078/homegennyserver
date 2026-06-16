import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AgreementsService } from '../src/modules/agreements/agreements.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const agreements = app.get(AgreementsService);
  const result = await agreements.sendEsignOtp({
    staff_id: 'a050834b-b25f-4f02-9844-26a3bdb7081a',
    agreement_type: 'A1',
    staff_name: 'anamika',
  });
  console.log('OK', result);
  await app.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
