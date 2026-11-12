import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { CandidatePhotosService } from "./candidate-photos.service";
import {
  CandidatePhotoQueryDto,
  CandidatePhotoUploadResponseDto,
} from "./dto/candidate-photos.dto";
import { ApiErrorDto } from "./dto/document.dto";

@ApiTags("candidates")
@Controller("v1/candidates")
export class CandidatePhotosController {
  constructor(private readonly photosService: CandidatePhotosService) {}

  @Get(":candidateId/photo")
  @Public()
  @ApiOperation({
    operationId: "getCandidatePhoto",
    summary: "Get candidate profile photo in WebP format (publicly cached)",
  })
  @ApiResponse({
    status: 200,
    description: "WebP profile photo",
    content: {
      "image/webp": {
        schema: { type: "string", format: "binary" },
      },
    },
  })
  @ApiResponse({ status: 304, description: "Not modified" })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  async getPhoto(
    @Param("candidateId") candidateId: string,
    @Query() query: CandidatePhotoQueryDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const size = query.size === "full" ? "full" : "thumb";
    const photo = await this.photosService.getPhoto(candidateId, size);
    if (!photo) {
      throw new NotFoundException("PHOTO_NOT_FOUND");
    }

    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatch === photo.etag) {
      return reply.status(304).send();
    }

    return reply
      .header("Content-Type", photo.contentType)
      .header("ETag", photo.etag)
      .header(
        "Cache-Control",
        "public, max-age=86400, stale-while-revalidate=604800",
      )
      .header("X-Content-Type-Options", "nosniff")
      .send(photo.buffer);
  }

  @Post(":candidateId/photo")
  @ApiBearerAuth("access-jwt")
  @RequireAccessRule(
    EdoAccessRule.DOCUMENT_REVIEW_RU,
    EdoAccessRule.DOCUMENT_REVIEW_IG,
  )
  @ApiOperation({
    operationId: "uploadCandidatePhoto",
    summary: "Upload candidate profile photo (requires RU or IG review permission)",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "string",
          format: "binary",
          description:
            "Candidate profile photo file (JPEG, PNG, WebP, HEIC up to 10MB)",
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: CandidatePhotoUploadResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorDto })
  @ApiResponse({ status: 401, type: ApiErrorDto })
  @ApiResponse({ status: 403, type: ApiErrorDto })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  async uploadPhoto(
    @Param("candidateId") candidateId: string,
    @Req() req: FastifyRequest,
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<CandidatePhotoUploadResponseDto> {
    if (!req.isMultipart()) {
      throw new BadRequestException("MULTIPART_REQUIRED");
    }

    let fileBuffer: Buffer | null = null;
    const parts = req.parts({
      limits: {
        files: 1,
        fileSize: 10 * 1024 * 1024,
      },
    });

    for await (const part of parts) {
      if (part.type === "file" && !fileBuffer) {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        if (part.file.truncated) {
          throw new BadRequestException("FILE_TOO_LARGE");
        }
        fileBuffer = Buffer.concat(chunks);
      } else if (part.type === "file") {
        part.file.resume();
      }
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException("FILE_REQUIRED");
    }

    const result = await this.photosService.uploadPhoto(
      candidateId,
      fileBuffer,
      principal,
    );

    return {
      success: true,
      photoPath: result.photoPath,
    };
  }
}
