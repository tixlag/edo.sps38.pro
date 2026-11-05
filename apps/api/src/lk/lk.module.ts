import { Module } from "@nestjs/common";
import { LkNotificationService } from "./lk-notification.service";
import { NotificationsController } from "./notifications.controller";

@Module({
  controllers: [NotificationsController],
  providers: [LkNotificationService],
  exports: [LkNotificationService],
})
export class LkModule {}
