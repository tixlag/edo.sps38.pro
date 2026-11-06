import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { LkNotificationService } from "../lk/lk-notification.service";
import { DocumentExpirationService } from "./document-expiration.service";

dotenvConfig({ path: join(__dirname, "..", "..", "..", "..", ".env") });

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const isDryRun = args.includes("--dry-run");

  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const config = new ConfigService(process.env);
  const prisma = new PrismaService();
  const lkNotifications = new LkNotificationService(config);

  if (isDryRun) {
    console.log("Running document expiration check in DRY-RUN mode (alerts will not be sent)...");
    // In dry-run mode, create a mock notification service that just logs
    const mockNotifications = {
      sendNotification: async (input: unknown) => {
        console.log("[DRY-RUN] Would send alert:", JSON.stringify(input));
        return { success: false, error: "DRY_RUN" };
      },
    } as unknown as LkNotificationService;

    const expirationService = new DocumentExpirationService(prisma, mockNotifications);
    const result = await expirationService.scanAndDispatchAlerts(new Date(), true);
    console.log(`Scan completed: ${result.scanned} documents scanned.`);
  } else {
    console.log("Running document expiration check and dispatching alerts to LK...");
    const expirationService = new DocumentExpirationService(prisma, lkNotifications);
    const result = await expirationService.scanAndDispatchAlerts();
    console.log(`Scan completed: ${result.scanned} documents scanned, ${result.alertsSent} alerts sent.`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Expiration check error:", err);
  process.exit(1);
});
