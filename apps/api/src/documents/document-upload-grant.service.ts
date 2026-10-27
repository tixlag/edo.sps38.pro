import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomUUID } from "node:crypto";
import * as jwt from "jsonwebtoken";
import {
  documentMetadataSchema,
  type DocumentMetadata,
} from "./document-contract";
import type { DocumentUploadGrantRequestDto } from "./dto/document.dto";

const issuer = "edo-document-upload";
const audience = "edo:candidate-document-upload";
export type UploadContext = Omit<DocumentMetadata, "documentFields">;
export interface DocumentUploadCapability {
  context: UploadContext;
  idempotencyKey: string;
}

@Injectable()
export class DocumentUploadGrantService {
  constructor(private readonly config: ConfigService) {}
  private key(): string {
    const secret = this.config.get<string>("EDO_LK_INTERNAL_TOKEN");
    if (!secret)
      throw new ServiceUnavailableException(
        "Document uploads are not configured",
      );
    return createHmac("sha256", secret)
      .update("edo-document-upload-grants:v1")
      .digest("hex");
  }
  grant(input: DocumentUploadGrantRequestDto) {
    const { idempotencyKey, candidateSnapshot, candidate_profile, ...owner } =
      input;
    if (
      typeof idempotencyKey !== "string" ||
      !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)
    )
      throw new BadRequestException("Invalid upload key");
    const parsed = documentMetadataSchema.safeParse({
      ...owner,
      candidateSnapshot: candidateSnapshot ?? candidate_profile,
      documentFields: {},
    });
    if (!parsed.success)
      throw new BadRequestException("Invalid document upload context");
    const { documentFields: _fields, ...context } = parsed.data;
    void _fields;
    const token = jwt.sign({ context, idempotencyKey }, this.key(), {
      algorithm: "HS256",
      issuer,
      audience,
      expiresIn: 300,
      jwtid: randomUUID(),
    });
    return {
      token,
      expiresAt: new Date(
        (jwt.decode(token) as jwt.JwtPayload).exp! * 1000,
      ).toISOString(),
      url: `${this.config.get<string>("EDO_PUBLIC_API_URL")!.replace(/\/$/, "")}/candidate-documents`,
    };
  }
  verify(token: string): DocumentUploadCapability {
    try {
      if (token.length > 8192) throw new Error("Invalid capability");
      const grant = jwt.verify(token, this.key(), {
        algorithms: ["HS256"],
        issuer,
        audience,
      }) as jwt.JwtPayload;
      if (
        !Number.isFinite(grant.exp) ||
        typeof grant.idempotencyKey !== "string" ||
        !/^[\x21-\x7e]{1,128}$/.test(grant.idempotencyKey)
      )
        throw new Error("Invalid capability");
      const { documentFields: _fields, ...context } =
        documentMetadataSchema.parse({ ...grant.context, documentFields: {} });
      void _fields;
      return { context, idempotencyKey: grant.idempotencyKey };
    } catch {
      throw new UnauthorizedException(
        "Invalid or expired document upload grant",
      );
    }
  }
}
@Injectable()
export class DocumentUploadGrantGuard implements CanActivate {
  constructor(private readonly grants: DocumentUploadGrantService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string; "idempotency-key"?: string };
      documentUploadCapability?: DocumentUploadCapability;
    }>();
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer "))
      throw new UnauthorizedException();
    const capability = this.grants.verify(header.slice(7));
    if (req.headers["idempotency-key"] !== capability.idempotencyKey)
      throw new UnauthorizedException("Upload key does not match the grant");
    req.documentUploadCapability = capability;
    return true;
  }
}
