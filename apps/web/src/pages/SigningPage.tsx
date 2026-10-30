import * as React from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSigningDocumentTypes,
  useGetSigningCandidate,
  useListSigningContracts,
  useCreateSigningContract,
  useGetSigningContract,
  useUploadSigningContractFile,
  useSendSigningContract,
  useListMySigningContracts,
  useGetMySigningContract,
  useConfirmMySigningContract,
  useDeclineMySigningContract,
  useGetMe,
  getListSigningContractsQueryKey,
  getGetSigningContractQueryKey,
  getListMySigningContractsQueryKey,
  getGetMySigningContractQueryKey,
  type ContractDto,
  type ContractDetailDto,
  type ContractState,
  type ContractBank,
} from "@edo/api-client";
import { Button, Card, EmptyState, PageHeader } from "@edo/ui";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSignature,
  FileText,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Search,
  Send,
  Upload,
  X,
} from "lucide-react";
import { formatDateRu, formatDateTimeRu } from "../lib/date-format";

type SigningSearch = { candidateId?: string; contractId?: string };
export const signingSearch = (
  search: Record<string, unknown>,
): SigningSearch => ({
  candidateId:
    typeof search.candidateId === "string" ? search.candidateId : undefined,
  contractId:
    typeof search.contractId === "string" ? search.contractId : undefined,
});
const POLL = {
  refetchInterval: 10_000,
  refetchOnWindowFocus: "always" as const,
};
const control =
  "min-h-10 w-full rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";
const stateLabels: Record<ContractState, string> = {
  PREPARING: "Формируется",
  DRAFT: "Черновик",
  WAITING_EMPLOYEE: "Ожидает подписи сотрудника",
  COMPLETED: "Подписан обеими сторонами",
  DECLINED: "Сотрудник отказался",
  FAILED: "Не удалось сформировать",
};
const banks: { code: ContractBank; name: string; icon: string }[] = [
  { code: "sber", name: "Сбер ID", icon: "/banks/sber.ico" },
  { code: "t", name: "Т-ID", icon: "/banks/t.ico" },
  { code: "alfa", name: "Альфа ID", icon: "/banks/alfa.ico" },
];
export function contractError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: unknown } } })
    ?.response?.data?.message;
  return typeof response === "string"
    ? response
    : "Не удалось выполнить действие. Проверьте соединение и повторите попытку.";
}
function Status({ status }: { status: ContractState }) {
  const tone =
    status === "COMPLETED"
      ? "bg-[var(--success-soft)]"
      : status === "WAITING_EMPLOYEE"
        ? "bg-[var(--warning-soft)]"
        : "bg-[var(--muted)]";
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${tone}`}
    >
      {stateLabels[status]}
    </span>
  );
}
function Message({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-[10px] border border-[var(--border)] bg-[var(--primary-soft)] p-3 text-sm"
    >
      {children}
    </p>
  );
}
function useContractRefresh() {
  const client = useQueryClient();
  return () =>
    client.invalidateQueries({
      predicate: (query) =>
        /\/contracts(?:\/|$)/.test(String(query.queryKey[0])),
    });
}
/** A retry keeps its key; a new revision, file or action receives another key. */
function useRequestId() {
  const requests = React.useRef(new Map<string, string>());
  return (key: string) => {
    let id = requests.current.get(key);
    if (!id) {
      id = crypto.randomUUID();
      requests.current.set(key, id);
    }
    return id;
  };
}
function ContractList({
  docs,
  open,
  own,
}: {
  docs: ContractDto[];
  open: (id: string) => void;
  own: boolean;
}) {
  return (
    <div className="divide-y divide-[var(--border)]">
      {docs.map((doc) => (
        <button
          type="button"
          key={doc.id}
          onClick={() => open(doc.id)}
          className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] sm:px-5"
        >
          <FileText size={22} className="shrink-0 text-[var(--primary)]" />
          <span className="min-w-0 flex-1">
            <strong className="block break-words text-sm">
              {doc.documentTypeName}
            </strong>
            {!own && (
              <span className="mt-1 block text-sm">
                {doc.fullName || "Имя не указано"}
              </span>
            )}
            <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
              {formatDateTimeRu(doc.createdAt)} · Версия {doc.version}
            </span>
          </span>
          <span className="hidden sm:inline">
            <Status status={doc.status} />
          </span>
          <ChevronRight size={18} className="shrink-0" />
          <span className="sr-only">{stateLabels[doc.status]}</span>
        </button>
      ))}
    </div>
  );
}
function SignatureDialog({
  role,
  name,
  pending,
  error,
  close,
  confirm,
}: {
  role: "employer" | "employee";
  name: string;
  pending: boolean;
  error: string;
  close: () => void;
  confirm: (bank?: ContractBank) => void;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const [bank, setBank] = React.useState<ContractBank>();
  React.useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="signing-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-[460px] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] p-0 text-[var(--foreground)] shadow-lg backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <span className="flex items-center gap-2 font-semibold">
          <LockKeyhole size={18} className="text-[var(--primary)]" /> Sign.Me
        </span>
        <button
          type="button"
          aria-label="Закрыть подписание"
          disabled={pending}
          onClick={close}
          className="rounded-lg p-2 hover:bg-[var(--muted)] disabled:opacity-50"
        >
          <X size={18} />
        </button>
      </div>
      <div className="space-y-5 p-5 sm:p-7">
        <h2 id="signing-dialog-title" className="text-xl font-bold">
          {role === "employer"
            ? "Подписание УКЭП"
            : bank
              ? "Подтверждение подписи"
              : "Подтвердите личность"}
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">{name}</p>
        {role === "employer" ? (
          <>
            <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] p-4">
              <KeyRound size={24} className="shrink-0 text-[var(--primary)]" />
              <div>
                <strong className="block text-sm">
                  Усиленная квалифицированная подпись
                </strong>
                <span className="mt-1 block text-sm text-[var(--muted-foreground)]">
                  Сертификат уполномоченного сотрудника работодателя
                </span>
              </div>
            </div>
            <p className="text-sm">
              Подтвердите подписание проверенного договора. После этого он будет
              отправлен сотруднику.
            </p>
            <Button
              className="w-full"
              disabled={pending}
              onClick={() => confirm()}
            >
              {pending ? (
                <LoaderCircle size={17} className="animate-spin" />
              ) : (
                <FileSignature size={17} />
              )}{" "}
              Подписать и отправить
            </Button>
          </>
        ) : bank ? (
          <>
            <div className="flex items-center gap-3 rounded-xl bg-[var(--muted)] p-4">
              <img
                src={banks.find((item) => item.code === bank)!.icon}
                alt=""
                className="h-10 w-10 object-contain"
              />
              <strong>{banks.find((item) => item.code === bank)!.name}</strong>
              <Check className="ml-auto text-[var(--success)]" size={22} />
            </div>
            <p className="text-sm">
              Подтвердите подписание договора, с которым вы ознакомились.
            </p>
            <Button
              className="w-full"
              disabled={pending}
              onClick={() => confirm(bank)}
            >
              {pending ? (
                <LoaderCircle size={17} className="animate-spin" />
              ) : (
                <FileSignature size={17} />
              )}{" "}
              Подписать документ
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={pending}
              onClick={() => setBank(undefined)}
            >
              Выбрать другой банк
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm">
              Выберите банк для подтверждения личности и подписания документа.
            </p>
            <div className="space-y-2">
              {banks.map((item) => (
                <button
                  type="button"
                  key={item.code}
                  onClick={() => setBank(item.code)}
                  className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] p-4 text-left hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                >
                  <img
                    src={item.icon}
                    alt=""
                    className="h-9 w-9 object-contain"
                  />
                  <strong className="flex-1 text-sm">
                    Войти по {item.name}
                  </strong>
                  <ChevronRight size={18} />
                </button>
              ))}
            </div>
          </>
        )}
        {error && <Message>{error}</Message>}
        <p className="text-xs text-[var(--muted-foreground)]">
          Тестовый режим: подключение к сервису электронной подписи пока не
          выполняется.
        </p>
      </div>
    </dialog>
  );
}
function ContractDetails({
  doc,
  own,
}: {
  doc: ContractDetailDto;
  own: boolean;
}) {
  const refresh = useContractRefresh();
  const requestId = useRequestId();
  const send = useSendSigningContract();
  const confirm = useConfirmMySigningContract();
  const decline = useDeclineMySigningContract();
  const upload = useUploadSigningContractFile();
  const [signing, setSigning] = React.useState(false);
  const [declining, setDeclining] = React.useState(false);
  const [error, setError] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [fileKey, setFileKey] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const previewKey = `${doc.id}:${doc.version}`;
  const [preview, setPreview] = React.useState({
    key: previewKey,
    url: doc.previewUrl,
  });
  React.useEffect(() => {
    // Polling renews signed URLs; keep the loaded reader on the same bytes so
    // a status update never resets its scroll position.
    setPreview((current) =>
      current.key !== previewKey || !current.url
        ? { key: previewKey, url: doc.previewUrl }
        : current,
    );
  }, [previewKey, doc.previewUrl]);
  const pending =
    send.isPending ||
    confirm.isPending ||
    decline.isPending ||
    upload.isPending;
  const editable = !own && ["DRAFT", "FAILED"].includes(doc.status);
  const base = () => ({
    revision: doc.revision,
    requestId: requestId(
      `${doc.id}:${doc.revision}:${own ? "confirm" : "send"}`,
    ),
  });
  async function sign(bank?: ContractBank) {
    setError("");
    try {
      if (own && bank)
        await confirm.mutateAsync({ id: doc.id, data: { ...base(), bank } });
      else if (!own) await send.mutateAsync({ id: doc.id, data: base() });
      else return;
      setSigning(false);
      setNotice(
        own
          ? "Договор подписан. Кадровик получит уведомление."
          : "Договор подписан вами и отправлен сотруднику.",
      );
      await refresh();
    } catch (failure) {
      setError(contractError(failure));
      await refresh();
    }
  }
  async function replaceFile(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setError("");
    setNotice("");
    try {
      await upload.mutateAsync({
        id: doc.id,
        data: {
          file,
          revision: doc.revision,
          requestId: requestId(`${doc.id}:${doc.revision}:file:${fileKey}`),
        },
      });
      setFile(null);
      setNotice("Новая версия сохранена. Проверьте PDF перед отправкой.");
      await refresh();
    } catch (failure) {
      setError(contractError(failure));
      await refresh();
    }
  }
  async function refuse() {
    setError("");
    try {
      await decline.mutateAsync({
        id: doc.id,
        data: {
          revision: doc.revision,
          requestId: requestId(`${doc.id}:${doc.revision}:decline`),
        },
      });
      setDeclining(false);
      await refresh();
    } catch (failure) {
      setError(contractError(failure));
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{doc.documentTypeName}</h2>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            {doc.fullName || "Имя не указано"} · Версия {doc.version}
          </p>
        </div>
        <Status status={doc.status} />
      </div>
      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl bg-[var(--success-soft)] p-4 text-sm"
        >
          <CheckCircle2 className="shrink-0" size={18} />
          {notice}
        </p>
      )}
      {error && !signing && <Message>{error}</Message>}
      {doc.errorMessage && <Message>{doc.errorMessage}</Message>}
      <div className="flex flex-wrap gap-2">
        {doc.previewUrl && (
          <button
            type="button"
            onClick={() => setPreview({ key: previewKey, url: doc.previewUrl })}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--muted)]"
          >
            Обновить просмотр
          </button>
        )}
        {doc.downloadUrl && (
          <a
            href={doc.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--muted)]"
          >
            <Download size={16} />
            Скачать PDF
          </a>
        )}
        {doc.originalDownloadUrl && (
          <a
            href={doc.originalDownloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--muted)]"
          >
            Исходный DOCX
          </a>
        )}
        {doc.journalDownloadUrl && (
          <a
            href={doc.journalDownloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--muted)]"
          >
            Журнал подтверждений
          </a>
        )}
      </div>
      {preview.url ? (
        <iframe
          title={`Просмотр: ${doc.documentTypeName}`}
          src={preview.url}
          className="h-[65dvh] min-h-[420px] w-full rounded-xl border border-[var(--border)] bg-[var(--card)]"
        />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-5 py-12 text-center text-sm text-[var(--muted-foreground)]">
          {doc.status === "PREPARING"
            ? "Формируем договор. Страница обновится автоматически."
            : "Загрузите PDF или DOCX для подготовки договора."}
        </div>
      )}
      {editable && (
        <form
          onSubmit={(event) => void replaceFile(event)}
          className="space-y-3 rounded-xl border border-[var(--border)] p-4"
        >
          <label
            htmlFor="contract-file"
            className="block text-sm font-semibold"
          >
            {doc.hasFile ? "Заменить файл договора" : "Загрузить договор"}
          </label>
          <input
            id="contract-file"
            key={doc.version}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={pending}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setFileKey(crypto.randomUUID());
            }}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--muted)] file:px-3 file:py-2 file:text-[var(--foreground)]"
          />
          <p className="text-xs text-[var(--muted-foreground)]">
            PDF или DOCX, до 50 МБ. DOCX будет преобразован в PDF. Предыдущие
            версии сохранятся.
          </p>
          <Button type="submit" variant="outline" disabled={!file || pending}>
            {upload.isPending ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <Upload size={16} />
            )}{" "}
            Сохранить файл
          </Button>
        </form>
      )}
      {editable && !doc.code1c && (
        <p className="rounded-xl bg-[var(--warning-soft)] p-4 text-sm">
          Договор сохранён как черновик. Чтобы отправить его сотруднику, сначала
          привяжите к карточке код сотрудника ЛК (code1c).
        </p>
      )}
      {editable && (
        <Button
          disabled={!doc.hasFile || !doc.code1c || pending}
          onClick={() => {
            setError("");
            setSigning(true);
          }}
        >
          <Send size={17} /> Подписать и отправить сотруднику
        </Button>
      )}
      {own && doc.status === "WAITING_EMPLOYEE" && (
        <div className="space-y-3">
          <p className="rounded-xl bg-[var(--info-soft)] p-4 text-sm">
            Работодатель подписал договор. Перед подписанием ознакомьтесь с
            документом полностью.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={pending || !doc.previewUrl}
              onClick={() => {
                setError("");
                setSigning(true);
              }}
            >
              <FileSignature size={17} /> Подписать
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDeclining(true)}
            >
              Отказаться от подписи
            </Button>
          </div>
          {declining && (
            <div className="space-y-3 rounded-xl border border-[var(--border)] p-4">
              <p className="text-sm">
                Отказаться от подписания этого договора? Кадровик получит
                уведомление.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={pending} onClick={() => void refuse()}>
                  Подтвердить отказ
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDeclining(false)}
                >
                  Вернуться к договору
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {!!doc.confirmations.length && (
        <section
          aria-label="История подписания"
          className="space-y-3 border-t border-[var(--border)] pt-5"
        >
          <h3 className="font-semibold">История подписания</h3>
          {doc.confirmations.map((item) => (
            <div key={item.role} className="flex items-start gap-3 text-sm">
              <CheckCircle2
                className="mt-0.5 shrink-0 text-[var(--success)]"
                size={18}
              />
              <div>
                <strong>
                  {item.role === "employer" ? "Работодатель" : "Сотрудник"}:{" "}
                  {item.actorLabel}
                </strong>
                <p className="mt-1 text-[var(--muted-foreground)]">
                  {formatDateTimeRu(item.confirmedAt)}
                  {item.bank
                    ? ` · ${banks.find((bank) => bank.code === item.bank)?.name ?? item.bank}`
                    : " · УКЭП"}
                </p>
              </div>
            </div>
          ))}
        </section>
      )}
      {signing && (
        <SignatureDialog
          role={own ? "employee" : "employer"}
          name={doc.fullName ?? doc.documentTypeName}
          pending={pending}
          error={error}
          close={() => setSigning(false)}
          confirm={(bank) => void sign(bank)}
        />
      )}
    </div>
  );
}
function ContractComposer({
  candidateId,
  open,
}: {
  candidateId: string;
  open: (id: string) => void;
}) {
  const person = useGetSigningCandidate(candidateId);
  const types = useListSigningDocumentTypes();
  const create = useCreateSigningContract();
  const [type, setType] = React.useState("");
  const [manual, setManual] = React.useState(false);
  const [error, setError] = React.useState("");
  const requestId = useRequestId();
  const refresh = useContractRefresh();
  const items = types.data?.items ?? [];
  const selected = type || items[0]?.code || (manual ? "manual" : "");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const doc = await create.mutateAsync({
        data: {
          candidateId,
          documentType: selected,
          manual,
          requestId: requestId(`${candidateId}:${selected}:${manual}`),
        },
      });
      await refresh();
      open(doc.id);
    } catch (failure) {
      setError(contractError(failure));
      await refresh();
    }
  }
  return (
    <Card className="p-4 sm:p-5">
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <h2 className="text-lg font-semibold">Подготовить договор</h2>
        {person.isPending ? (
          <p role="status" className="text-sm">
            Загрузка карточки сотрудника…
          </p>
        ) : person.isError ? (
          <Message>{contractError(person.error)}</Message>
        ) : (
          <div>
            <p className="font-semibold">
              {person.data?.fullName || "Имя не указано"}
            </p>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Дата рождения: {formatDateRu(person.data?.birthDate)}
            </p>
          </div>
        )}
        {types.isError && (
          <div className="space-y-2">
            <Message>
              Не удалось получить типы договоров из ЗУП. Повторите загрузку или
              подготовьте договор из своего файла.
            </Message>
            <Button
              type="button"
              variant="outline"
              disabled={types.isFetching}
              onClick={() => void types.refetch()}
            >
              Повторить загрузку типов
            </Button>
          </div>
        )}
        {types.isPending && (
          <p role="status" className="text-sm">
            Загрузка типов договоров из ЗУП…
          </p>
        )}
        {!!items.length && (
          <label className="block space-y-2 text-sm font-semibold">
            <span>Тип договора</span>
            <select
              value={selected}
              onChange={(event) => setType(event.target.value)}
              disabled={create.isPending}
              className={control}
            >
              {items.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={manual}
            disabled={create.isPending}
            onChange={(event) => setManual(event.target.checked)}
            className="h-4 w-4 accent-[var(--primary)]"
          />
          Загрузить свой PDF или DOCX
        </label>
        <p className="text-sm text-[var(--muted-foreground)]">
          {manual
            ? "Создадим черновик, в который вы сможете загрузить файл."
            : "Получим печатную форму из ЗУП и сохраним черновик. Перед отправкой вы сможете проверить или заменить файл."}
        </p>
        {error && <Message>{error}</Message>}
        <Button
          type="submit"
          disabled={
            create.isPending ||
            !person.data ||
            !selected ||
            (!manual && (!person.data.fullName || !person.data.birthDate))
          }
        >
          {create.isPending ? (
            <LoaderCircle size={17} className="animate-spin" />
          ) : manual ? (
            <Upload size={17} />
          ) : (
            <FileText size={17} />
          )}
          {create.isPending
            ? "Подготавливаем договор…"
            : manual
              ? "Создать черновик"
              : "Сформировать договор"}
        </Button>
      </form>
    </Card>
  );
}
export function SigningPage() {
  const search = useSearch({ strict: false }) as ReturnType<
    typeof signingSearch
  >;
  const navigate = useNavigate();
  const [filter, setFilter] = React.useState("");
  const params = { candidateId: search.candidateId };
  const list = useListSigningContracts(params, {
    query: { ...POLL, queryKey: getListSigningContractsQueryKey(params) },
  });
  const selected = useGetSigningContract(search.contractId ?? "", {
    query: {
      ...POLL,
      queryKey: getGetSigningContractQueryKey(search.contractId ?? ""),
      enabled: !!search.contractId,
    },
  });
  const open = (id: string) =>
    void navigate({
      to: "/signing",
      search: { candidateId: search.candidateId, contractId: id },
    });
  const docs = (list.data?.items ?? []).filter((item) =>
    `${item.documentTypeName} ${item.fullName ?? ""}`
      .toLocaleLowerCase("ru")
      .includes(filter.toLocaleLowerCase("ru")),
  );
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-7">
      <div className="mx-auto max-w-[1440px] space-y-6 pb-8">
        <PageHeader
          title="Подписание документов"
          subtitle="Договоры сотрудников и состояние подписания"
        />
        {search.contractId ? (
          <>
            <Button
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/signing",
                  search: { candidateId: search.candidateId },
                })
              }
            >
              <ArrowLeft size={17} />К договорам
            </Button>
            <Card className="p-4 sm:p-6">
              {selected.isPending ? (
                <p role="status">Загрузка договора…</p>
              ) : selected.isError ? (
                <div className="space-y-3">
                  <Message>{contractError(selected.error)}</Message>
                  <Button
                    variant="outline"
                    onClick={() => void selected.refetch()}
                  >
                    Повторить
                  </Button>
                </div>
              ) : (
                selected.data && (
                  <ContractDetails
                    key={selected.data.id}
                    doc={selected.data}
                    own={false}
                  />
                )
              )}
            </Card>
          </>
        ) : (
          <>
            {search.candidateId && (
              <ContractComposer candidateId={search.candidateId} open={open} />
            )}
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4 sm:p-5">
                <h2 className="font-semibold">
                  {search.candidateId ? "Договоры сотрудника" : "Все договоры"}
                </h2>
                <label className="flex w-full items-center gap-2 rounded-[10px] border border-[var(--border)] px-3 sm:max-w-[360px]">
                  <Search
                    size={16}
                    className="shrink-0 text-[var(--muted-foreground)]"
                  />
                  <input
                    aria-label="Поиск договоров"
                    placeholder="Сотрудник или тип договора"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
                  />
                </label>
              </div>
              {list.isPending ? (
                <p role="status" className="p-5 text-sm">
                  Загрузка договоров…
                </p>
              ) : list.isError ? (
                <div className="space-y-3 p-5">
                  <Message>{contractError(list.error)}</Message>
                  <Button variant="outline" onClick={() => void list.refetch()}>
                    Повторить
                  </Button>
                </div>
              ) : !docs.length ? (
                <EmptyState
                  title="Договоров пока нет"
                  description={
                    search.candidateId
                      ? "Подготовьте договор из ЗУП или загрузите свой файл."
                      : "Откройте сотрудника в проверке документов и нажмите «Договор»."
                  }
                />
              ) : (
                <ContractList docs={docs} open={open} own={false} />
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
export function MyDocumentsPage() {
  const search = useSearch({ strict: false }) as ReturnType<
    typeof signingSearch
  >;
  const navigate = useNavigate();
  const profile = useGetMe();
  const [all, setAll] = React.useState(false);
  const list = useListMySigningContracts({
    query: {
      ...POLL,
      queryKey: getListMySigningContractsQueryKey(),
      enabled: !!profile.data?.code1c,
    },
  });
  const selected = useGetMySigningContract(search.contractId ?? "", {
    query: {
      ...POLL,
      queryKey: getGetMySigningContractQueryKey(search.contractId ?? ""),
      enabled: !!search.contractId && !!profile.data?.code1c,
    },
  });
  const open = (id: string) =>
    void navigate({ to: "/my-documents", search: { contractId: id } });
  const docs = (list.data?.items ?? []).filter(
    (doc) => all || doc.status === "WAITING_EMPLOYEE",
  );
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-7">
      <div className="mx-auto max-w-[1100px] space-y-5 pb-8">
        <PageHeader
          title="Мои документы"
          subtitle="Документы от работодателя для ознакомления и подписания"
        />
        {!profile.data?.code1c ? (
          <EmptyState
            title="Не найдена привязка сотрудника"
            description="В вашей сессии ЛК отсутствует код сотрудника. Обратитесь к кадровику для проверки привязки учётной записи."
          />
        ) : search.contractId ? (
          <>
            <Button
              variant="outline"
              onClick={() => void navigate({ to: "/my-documents", search: {} })}
            >
              <ArrowLeft size={17} />
              Мои документы
            </Button>
            <Card className="p-4 sm:p-6">
              {selected.isPending ? (
                <p role="status">Загрузка договора…</p>
              ) : selected.isError ? (
                <div className="space-y-3">
                  <Message>{contractError(selected.error)}</Message>
                  <Button
                    variant="outline"
                    onClick={() => void selected.refetch()}
                  >
                    Повторить
                  </Button>
                </div>
              ) : (
                selected.data && (
                  <ContractDetails
                    key={selected.data.id}
                    doc={selected.data}
                    own
                  />
                )
              )}
            </Card>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={!all ? "default" : "outline"}
                aria-pressed={!all}
                onClick={() => setAll(false)}
              >
                Требуют подписи
              </Button>
              <Button
                variant={all ? "default" : "outline"}
                aria-pressed={all}
                onClick={() => setAll(true)}
              >
                Все документы
              </Button>
            </div>
            <Card>
              {list.isPending ? (
                <p role="status" className="p-5 text-sm">
                  Загрузка документов…
                </p>
              ) : list.isError ? (
                <div className="space-y-3 p-5">
                  <Message>{contractError(list.error)}</Message>
                  <Button variant="outline" onClick={() => void list.refetch()}>
                    Повторить
                  </Button>
                </div>
              ) : !docs.length ? (
                <EmptyState
                  title={
                    all
                      ? "Документов пока нет"
                      : "Нет документов, требующих подписи"
                  }
                  description="Когда работодатель отправит договор, он появится здесь."
                />
              ) : (
                <ContractList docs={docs} open={open} own />
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
