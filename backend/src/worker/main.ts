import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const port = Number(process.env.SYNC_WORKER_PORT ?? 4010);
  const host = process.env.SYNC_WORKER_HOST ?? '127.0.0.1';
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(WorkerModule, {
    transport: Transport.TCP,
    options: { host, port },
  });
  await app.listen();
  console.log(`SGuard sync-worker berjalan di tcp://${host}:${port}`);
}
void bootstrap();
