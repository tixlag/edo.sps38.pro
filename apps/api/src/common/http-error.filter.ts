import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";

import { CandidateDocumentError } from "../documents/candidate-document.error";
import { CandidateDocumentErrorCode as Code } from "../documents/dto/candidate-error.dto";

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse() as {
      status: (code: number) => { send: (body: unknown) => void };
    };
    const req = ctx.getRequest() as { correlationId?: string; url?: string };

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw =
      exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      typeof raw === "string"
        ? raw
        : ((raw as { message?: unknown } | null)?.message ??
          "Internal server error");

    const documentRequest = req.url?.startsWith("/api/candidate-documents/");
    const documentError =
      exception instanceof CandidateDocumentError
        ? exception
        : documentRequest
          ? new CandidateDocumentError(
              status === 401
                ? Code.AUTH_REQUIRED
                : status === 403
                  ? Code.DOCUMENT_ACCESS_DENIED
                  : status === 400
                    ? Code.DOCUMENT_REQUEST_INVALID
                    : status === 404
                      ? Code.DOCUMENT_NOT_FOUND
                      : status === 409
                        ? Code.DOCUMENT_CONFLICT
                        : Code.DOCUMENTS_UNAVAILABLE,
            )
          : null;
    const details = documentError?.getResponse() as
      | Record<string, unknown>
      | undefined;
    if (documentError) {
      new Logger("CandidateDocuments").warn({
        code: documentError.code,
        status,
        ...documentError.diagnostic,
        correlationId: req.correlationId ?? null,
      });
    }
    reply.status(status).send({
      statusCode: status,
      message: details?.message ?? message,
      ...(details
        ? {
            code: details.code,
            retryable: details.retryable,
            ...(details.fields ? { fields: details.fields } : {}),
          }
        : {}),
      correlationId: req.correlationId ?? null,
      path: req.url ?? null,
    });
  }
}
