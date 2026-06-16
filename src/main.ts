import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, VersioningType, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });

  const configService = app.get(ConfigService);
  const port    = configService.get<number>('app.port', 3001);
  const nodeEnv = configService.get<string>('app.env', 'development');

  // Security headers via helmet (require-style for CJS compat)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const helmet      = require('helmet');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const compression = require('compression');
  app.use(helmet());
  app.use(compression());

  // CORS
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? ['http://localhost:3000'];
  app.enableCors({
    origin:      corsOrigins,
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // API versioning + global prefix
  app.enableVersioning({ type: VersioningType.URI });
  app.setGlobalPrefix('api', {
    exclude: [{ path: '/', method: RequestMethod.ALL }],
  });

  // Global pipes / filters / interceptors
  app.useGlobalPipes(new ValidationPipe({
    whitelist:           true,
    transform:           true,
    forbidNonWhitelisted: true,
  }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

  // WebSocket adapter
  app.useWebSocketAdapter(new IoAdapter(app));

  // Swagger docs (non-production only)
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('HomeGenny API')
      .setDescription('HomeGenny Domestic Staffing Platform — Full API Reference')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('Auth')
      .addTag('Staff Onboarding')
      .addTag('Pipeline')
      .addTag('Verification')
      .addTag('Video Certification')
      .addTag('Payroll')
      .addTag('Placements')
      .addTag('Matching & Placement')
      .addTag('Notifications')
      .addTag('Restricted List')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
    logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
  }

  await app.listen(port);
  logger.log(`HomeGenny API running on http://localhost:${port}/api/v1`);
  logger.log(`Environment: ${nodeEnv}`);
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error(
    `Fatal startup error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
