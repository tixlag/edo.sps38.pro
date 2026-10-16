import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LkEdoClient, LkNotFoundError } from "@edo/lk-client";

@Injectable()
export class LkCandidateIdentityService {
  private readonly client: LkEdoClient;
  constructor(config: ConfigService) {
    this.client = new LkEdoClient({
      baseUrl: config.get<string>("LK_BASE_URL") ?? "",
      internalToken: config.get<string>("LK_EDO_INTERNAL_TOKEN") ?? "",
      maxRetries: 0,
    });
  }
  async byUuid(chatUuid: string, signal?: AbortSignal) {
    try {
      return await this.client.getCandidateChat(chatUuid, { signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof LkNotFoundError)
        throw new NotFoundException("LK_HTTP_404");
      throw new ServiceUnavailableException("LK_HTTP_503");
    }
  }
  async byEmployee(code1c: string, signal?: AbortSignal) {
    try {
      return await this.client.getEmployeeCandidateChat(code1c, { signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof LkNotFoundError)
        throw new NotFoundException("LK_HTTP_404");
      throw new ServiceUnavailableException("LK_HTTP_503");
    }
  }
}
