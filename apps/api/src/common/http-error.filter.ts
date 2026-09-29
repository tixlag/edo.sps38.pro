import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse() as {
      status: (code: number) => { send: (body: unknown) => void };
    };
    const req = ctx.getRequest() as { correlationId?: string; url?: string };

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      typeof raw === 'string'
        ? raw
        : ((raw as { message?: unknown } | null)?.message ?? 'Internal server error');

    reply.status(status).send({
      statusCode: status,
      message,
      correlationId: req.correlationId ?? null,
      path: req.url ?? null,
    });
  }
}
