import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { createHash, timingSafeEqual } from "node:crypto";
import { Public } from "../auth/public.decorator";
import {
  ERP_CHANGE_CATEGORIES,
  ERP_CHANGE_TARGETS,
  ErpChangeInboxService,
  erpChangesSchema,
  type ErpChangeCategory,
  type ErpChangeTarget,
} from "./erp-change-inbox";

@Injectable()
export class ErpChangesGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>("EDO_ERP_CHANGES_TOKEN")?.trim();
    const { headers } = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const auth = headers.authorization;
    const digest = (value: string) =>
      createHash("sha256").update(value).digest();
    if (
      !secret ||
      typeof auth !== "string" ||
      !auth.startsWith("Bearer ") ||
      !timingSafeEqual(digest(auth.slice(7)), digest(secret))
    )
      throw new UnauthorizedException("Invalid service credential");
    return true;
  }
}

class ErpChangeItemDto {
  @ApiProperty({ format: "uuid" })
  eventId!: string;

  @ApiProperty({ enum: ERP_CHANGE_TARGETS, enumName: "ErpChangeTarget" })
  target!: ErpChangeTarget;

  @ApiProperty({ format: "uuid" })
  uid!: string;

  @ApiProperty({
    enum: ERP_CHANGE_CATEGORIES,
    enumName: "ErpChangeCategory",
    isArray: true,
    minItems: 1,
    maxItems: 3,
  })
  changes!: ErpChangeCategory[];
}

class ErpChangesDto {
  @ApiProperty({ enum: [1] })
  version!: 1;

  @ApiProperty({ type: [ErpChangeItemDto], minItems: 1, maxItems: 50 })
  items!: ErpChangeItemDto[];
}

@Public()
@UseGuards(ErpChangesGuard)
@ApiTags("ERP Integration")
@ApiBearerAuth("erp-changes-token")
@Controller("internal/erp/v1/changes")
export class ErpChangesController {
  constructor(private readonly inbox: ErpChangeInboxService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    operationId: "enqueueErpChanges",
    summary: "Store ERP candidate and person change notifications",
  })
  @ApiBody({ type: ErpChangesDto })
  @ApiResponse({ status: 202, description: "Notifications committed" })
  @ApiResponse({ status: 400, description: "Invalid notification batch" })
  @ApiResponse({ status: 401, description: "Invalid service credential" })
  @ApiResponse({ status: 503, description: "Storage unavailable" })
  async accept(@Body() body: unknown): Promise<void> {
    const parsed = erpChangesSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("INVALID_ERP_CHANGES");
    try {
      await this.inbox.accept(parsed.data.items);
    } catch {
      throw new ServiceUnavailableException("ERP_CHANGE_INBOX_UNAVAILABLE");
    }
  }
}
