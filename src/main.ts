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
    // Keeps the exact bytes of each request body on `req.rawBody`. The
    // Razorpay webhook signs the raw payload, so re-serialising the parsed
    // JSON would produce a different string and every valid signature would
    // fail to verify. See F-08 in docs/FINANCE_MODULE_AUDIT.md.
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  const port    = configService.get<number>('app.port', 3001);
  const nodeEnv = configService.get<string>('app.env', 'development');

  // Security headers via helmet (require-style for CJS compat)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const helmet      = require('helmet');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const compression = require('compression');
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(compression());

  // CORS - Allow localhost on any port (for Flutter Web dev) + mobile web origins
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.endsWith('.onrender.com') ||
        origin.endsWith('.homegenny.com') ||
        nodeEnv !== 'production'
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'x-seed-secret'],
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

  // Handle favicon to avoid 404 logs
  app.use('/favicon.ico', (req: any, res: any) => res.status(204).end());

  // Swagger docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('HomeGenny API')
    .setDescription('HomeGenny Domestic Staffing Platform — Full API Reference')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Auth')
    .addTag('Mobile App Auth APIs')
    .addTag('RM Operations')
    .addTag('Staff Mobile App')
    .addTag('Mobile App RM APIs')
    .addTag('Mobile App Staff APIs')
    .addTag('Mobile App Client APIs')
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
  SwaggerModule.setup('api/docs', app, document, {
    useGlobalPrefix: false,
  });
  logger.log(`Swagger docs: http://localhost:${port}/api/docs`);

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
