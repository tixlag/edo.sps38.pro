import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";
import { LkNotificationService } from "./lk-notification.service";
import {
  MarkNotificationsReadDto,
  MarkNotificationsReadResponseDto,
  NotificationsListResponseDto,
  NotificationsQueryDto,
} from "./dto/notifications.dto";

@ApiTags("notifications")
@ApiBearerAuth("access-jwt")
@Controller("v1/notifications")
export class NotificationsController {
  constructor(private readonly lkNotifications: LkNotificationService) {}

  @Get("my")
  @ApiOperation({
    operationId: "getMyNotifications",
    summary: "Получить список уведомлений текущего пользователя из ЛК",
  })
  @ApiResponse({
    status: 200,
    description: "Список уведомлений с количеством непрочитанных",
    type: NotificationsListResponseDto,
  })
  async getMyNotifications(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: NotificationsQueryDto,
  ): Promise<NotificationsListResponseDto> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const status = query.status ?? "all";

    const result = await this.lkNotifications.listUserNotifications(
      principal.uuid,
      limit,
      offset,
      status,
    );

    return {
      items: result.items,
      unreadCount: result.unreadCount,
      total: result.total,
    };
  }

  @Post("read")
  @ApiOperation({
    operationId: "markNotificationsRead",
    summary: "Отметить уведомления текущего пользователя как прочитанные",
  })
  @ApiResponse({
    status: 200,
    description: "Количество отмеченных уведомлений",
    type: MarkNotificationsReadResponseDto,
  })
  async markRead(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: MarkNotificationsReadDto,
  ): Promise<MarkNotificationsReadResponseDto> {
    const result = await this.lkNotifications.markRead(principal.uuid, {
      notificationUuids: body.notificationUuids,
      all: body.all,
    });

    return { updated: result.updated };
  }
}
