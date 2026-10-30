import { HttpException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const typeSchema = z.object({
  code: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(512),
  source_object: z.string().trim().min(1).max(512),
});
const catalogSchema = z.object({
  document_types: z.array(typeSchema).max(1000),
});
export type ZupDocumentType = z.infer<typeof typeSchema>;

/** Server-only ZUP credential boundary. Never exposes upstream text or credentials. */
@Injectable()
export class ZupDocumentsClient {
  constructor(private readonly config: ConfigService) {}

  async types(): Promise<ZupDocumentType[]> {
    const bytes = await this.request(
      "document-types",
      "GET",
      15_000,
      MAX_JSON_BYTES,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw this.invalidResponse();
    }
    const result = catalogSchema.safeParse(parsed);
    if (
      !result.success ||
      new Set(result.data.document_types.map((row) => row.code)).size !==
        result.data.document_types.length
    )
      throw this.invalidResponse();
    return result.data.document_types;
  }

  async generate(input: {
    full_name: string;
    birth_date: string;
    document_type: string;
  }): Promise<Buffer> {
    const bytes = await this.request(
      "employment-contract",
      "POST",
      120_000,
      MAX_PDF_BYTES,
      input,
    );
    // Structural validation is performed again by ContractFileService before persistence.
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      throw this.invalidResponse();
    return bytes;
  }

  private invalidResponse(): HttpException {
    return new HttpException(
      "ЗУП вернула некорректный ответ. Попробуйте повторить запрос.",
      502,
    );
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    timeout: number,
    limit: number,
    body?: unknown,
  ): Promise<Buffer> {
    const basic = this.config.get<string>("ZUP_DOCUMENTS_BASIC_AUTH")?.trim();
    const apiKey = this.config.get<string>("ZUP_DOCUMENTS_API_KEY")?.trim();
    if (
      !basic ||
      !apiKey ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(basic) ||
      /[\r\n]/.test(apiKey)
    )
      throw new HttpException(
        "Получение договоров из ЗУП не настроено. Обратитесь к администратору.",
        503,
      );
    let url: URL;
    try {
      const base =
        this.config.get<string>("ZUP_DOCUMENTS_BASE_URL") ||
        "http://10.10.2.0/ZUP3_SPS_labs/hs/zup-documents/";
      url = new URL(path, base.endsWith("/") ? base : `${base}/`);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Invalid URL");
    } catch {
      throw new HttpException(
        "Адрес сервиса договоров ЗУП настроен некорректно.",
        503,
      );
    }
    const signal = AbortSignal.timeout(timeout);
    try {
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal,
        headers: {
          Authorization: `Basic ${basic}`,
          "X-API-Key": apiKey,
          Accept:
            method === "POST"
              ? "application/pdf, application/json"
              : "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const bytes = await this.readBounded(
        response,
        response.ok ? limit : MAX_JSON_BYTES,
      );
      if (!response.ok) {
        let code: unknown;
        try {
          code = (JSON.parse(bytes.toString("utf8")) as { error?: unknown })
            .error;
        } catch {
          /* safe generic error below */
        }
        if (response.status === 401 || response.status === 403)
          throw new HttpException(
            "ЗУП отклонила авторизацию ЭДО. Обратитесь к администратору.",
            503,
          );
        if (response.status === 400 && code === "invalid_request")
          throw new HttpException(
            "ЗУП отклонила данные договора. Проверьте ФИО, дату рождения и тип документа.",
            400,
          );
        if (response.status === 404 && code === "employee_not_found")
          throw new HttpException(
            "Сотрудник не найден в ЗУП. Проверьте данные карточки.",
            404,
          );
        if (response.status === 409 && code === "employee_ambiguous")
          throw new HttpException(
            "В ЗУП найдено несколько сотрудников с такими данными. Уточните карточку в ЗУП.",
            409,
          );
        if (response.status === 500 && code === "generation_failed")
          throw new HttpException(
            "ЗУП не удалось сформировать договор. Попробуйте повторить запрос.",
            502,
          );
        throw new HttpException(
          "Сервис договоров ЗУП временно недоступен. Попробуйте позже.",
          502,
        );
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();
      if (
        contentType !==
        (method === "POST" ? "application/pdf" : "application/json")
      )
        throw this.invalidResponse();
      return bytes;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (signal.aborted)
        throw new HttpException(
          "ЗУП не ответила вовремя. Попробуйте повторить запрос.",
          504,
        );
      throw new HttpException(
        "Не удалось связаться с ЗУП. Попробуйте позже.",
        502,
      );
    }
  }

  private async readBounded(
    response: Response,
    limit: number,
  ): Promise<Buffer> {
    if (Number(response.headers.get("content-length") ?? "0") > limit) {
      await response.body?.cancel();
      throw this.invalidResponse();
    }
    const reader = response.body?.getReader();
    if (!reader) throw this.invalidResponse();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw this.invalidResponse();
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  }
}
