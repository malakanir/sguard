import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/** Semua error dibungkus ke satu format: statusCode, error, message, path, timestamp. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const path = ctx.getRequest<{ url: string }>().url;

    const { status, message, error } = this.resolve(exception);

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    const body: ErrorBody = {
      statusCode: status,
      error,
      message,
      path,
      timestamp: new Date().toISOString(),
    };
    response.status(status).json(body);
  }

  private resolve(exception: unknown): { status: number; message: string | string[]; error: string } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      let message: string | string[] = exception.message;
      if (typeof res === 'object' && res !== null && 'message' in res) {
        message = (res as { message: string | string[] }).message;
      }
      return { status, message, error: HttpStatus[status] ?? 'Error' };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { status: 409, message: 'Data sudah ada (duplikat).', error: 'Conflict' };
      }
      if (exception.code === 'P2025') {
        return { status: 404, message: 'Data tidak ditemukan.', error: 'Not Found' };
      }
    }

    const dbUnreachable =
      exception instanceof Prisma.PrismaClientInitializationError ||
      (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P1001');
    if (dbUnreachable) {
      return { status: 503, message: 'Database tidak bisa dihubungi. Coba lagi sebentar.', error: 'Service Unavailable' };
    }

    return { status: 500, message: 'Terjadi kesalahan pada server.', error: 'Internal Server Error' };
  }
}
