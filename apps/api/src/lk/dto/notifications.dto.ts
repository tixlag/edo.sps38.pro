import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export class NotificationTargetDto {
  @ApiPropertyOptional({ description: "Тип цели" })
  type?: string;

  @ApiPropertyOptional({ description: "URL перехода" })
  url?: string;

  @ApiPropertyOptional({ description: "Метаданные цели", type: Object })
  meta?: Record<string, unknown>;
}

export class NotificationItemDto {
  @ApiProperty({ description: "UUID уведомления" })
  uuid!: string;

  @ApiProperty({ description: "Заголовок" })
  title!: string;

  @ApiProperty({ description: "Текст (поддерживает Markdown)" })
  content!: string;

  @ApiProperty({ enum: ["toast", "modal"], description: "Тип отображения" })
  type!: string;

  @ApiProperty({ description: "Дата создания (ISO 8601)" })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true, description: "Дата прочтения (ISO 8601 или null)" })
  readAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: "Имя автора" })
  authorName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: "URL аватара автора" })
  authorAvatarUrl?: string | null;

  @ApiPropertyOptional({ type: NotificationTargetDto, nullable: true, description: "Целевое действие" })
  target?: NotificationTargetDto | null;
}

export class NotificationsListResponseDto {
  @ApiProperty({ type: [NotificationItemDto], description: "Список уведомлений" })
  items!: NotificationItemDto[];

  @ApiProperty({ description: "Количество непрочитанных уведомлений" })
  unreadCount!: number;

  @ApiProperty({ description: "Общее количество уведомлений" })
  total!: number;
}

export class NotificationsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ enum: ["all", "unread", "read"], default: "all" })
  @IsOptional()
  @IsIn(["all", "unread", "read"])
  status?: "all" | "unread" | "read";
}

export class MarkNotificationsReadDto {
  @ApiPropertyOptional({ type: [String], description: "Список UUID уведомлений для отметки прочитанными" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  notificationUuids?: string[];

  @ApiPropertyOptional({ description: "Отметить все уведомления пользователя прочитанными" })
  @IsOptional()
  @IsBoolean()
  all?: boolean;
}

export class MarkNotificationsReadResponseDto {
  @ApiProperty({ description: "Количество обновлённых записей" })
  updated!: number;
}
