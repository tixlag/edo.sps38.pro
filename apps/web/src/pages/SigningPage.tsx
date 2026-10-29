import * as React from "react";
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, FilePlus2, FileText,
  Inbox, Plus, Search, Send, Upload, UserRound, XCircle,
} from "lucide-react";
import { Button, Card, EmptyState, PageHeader } from "@edo/ui";

type Status = "draft" | "waiting" | "signed" | "attention" | "declined" | "accepted";
type Role = "hr" | "employee";
type Tab = "incoming" | "signed" | "requests";
type DemoEvent = { label: string; date: string };
type DemoDocument = {
  id: string;
  title: string;
  person: string;
  number: string;
  date: string;
  status: Status;
  kind: "contract" | "vacation";
  description: string;
  events: DemoEvent[];
  file?: File;
};

const PEOPLE = ["Иванов Алексей Сергеевич", "Петрова Мария Андреевна", "Ким Александр Викторович"];
const SEED: DemoDocument[] = [
  { id: "demo-1", title: "Трудовой договор", person: PEOPLE[0], number: "ТД-2026-014", date: "29.10.2026", status: "waiting", kind: "contract", description: "Договор подготовлен и ожидает подписи сотрудника.", events: [{ label: "Отправлен сотруднику на подпись", date: "29.10.2026" }, { label: "Договор подготовлен кадровиком", date: "28.10.2026" }] },
  { id: "demo-2", title: "Трудовой договор", person: PEOPLE[1], number: "ТД-2026-013", date: "27.10.2026", status: "signed", kind: "contract", description: "Договор подписан обеими сторонами в демонстрации.", events: [{ label: "Подписан сотрудником и работодателем", date: "27.10.2026" }, { label: "Отправлен сотруднику на подпись", date: "26.10.2026" }] },
  { id: "demo-3", title: "Трудовой договор", person: PEOPLE[2], number: "ТД-2026-012", date: "26.10.2026", status: "attention", kind: "contract", description: "Требуется уточнить данные перед отправкой.", events: [{ label: "Договор требует внимания", date: "26.10.2026" }] },
  { id: "demo-4", title: "Трудовой договор", person: PEOPLE[0], number: "ТД-2026-015", date: "29.10.2026", status: "draft", kind: "contract", description: "Черновик договора готов к проверке.", events: [{ label: "Черновик создан", date: "29.10.2026" }] },
];
// Shared across route changes in this tab; reloading the page restores the examples.
let sessionDocuments: DemoDocument[] = SEED.map((doc) => ({ ...doc, events: [...doc.events] }));
const STATUS: Record<Status, { text: string; classes: string }> = {
  draft: { text: "Черновик", classes: "bg-[var(--muted)] text-[var(--muted-foreground)]" },
  waiting: { text: "Ожидает подписи", classes: "bg-[var(--warning-soft)] text-[var(--foreground)]" },
  signed: { text: "Подписан", classes: "bg-[var(--success-soft)] text-[var(--foreground)]" },
  attention: { text: "Требует внимания", classes: "bg-[var(--primary-soft)] text-[var(--primary)]" },
  declined: { text: "Отказ от подписи", classes: "bg-[var(--primary-soft)] text-[var(--primary)]" },
  accepted: { text: "Принято", classes: "bg-[var(--success-soft)] text-[var(--foreground)]" },
};
const control = "h-10 w-full rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]";

function StatusLabel({ status, kind }: { status: Status; kind: DemoDocument["kind"] }) {
  const { text, classes } = STATUS[status];
  const label = kind === "vacation" && status === "waiting" ? "Отправлено кадровику" : text;
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${classes}`}><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />{label}</span>;
}
function today() { return new Intl.DateTimeFormat("ru-RU").format(new Date()); }

function DocumentPreview({ doc }: { doc: DemoDocument }) {
  const [url, setUrl] = React.useState<string>();
  React.useEffect(() => {
    if (!doc.file) { setUrl(undefined); return; }
    const next = URL.createObjectURL(doc.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [doc.file]);
  if (doc.file && url) return <iframe title={`Просмотр: ${doc.title}`} src={url} className="min-h-[480px] w-full rounded-lg border border-[var(--border)] bg-[var(--card)]" />;
  return (
    <div className="mx-auto min-h-[420px] max-w-[570px] rounded-sm border border-[var(--border)] bg-[var(--card)] px-8 py-10 text-sm leading-7 shadow-sm sm:px-12">
      <p className="text-center text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Демонстрационный образец</p>
      <h3 className="mt-8 text-center text-lg font-bold">{doc.title} № {doc.number}</h3>
      {doc.kind === "contract" ? <>
        <div className="mt-5 flex justify-between gap-3 text-xs text-[var(--muted-foreground)]"><span>г. Иркутск</span><span>{doc.date}</span></div>
        <p className="mt-7">Работодатель и <strong>{doc.person}</strong> заключили настоящий трудовой договор на следующих условиях.</p>
        <p className="mt-5 font-semibold">1. Общие положения</p>
        <p>Работник принимается на работу в соответствии с условиями, согласованными сторонами.</p>
        <p className="mt-5 font-semibold">2. Права и обязанности сторон</p>
        <p>Стороны исполняют обязанности в соответствии с трудовым законодательством и условиями договора.</p>
        <p className="mt-7 text-xs text-[var(--muted-foreground)]">Текст приведён для демонстрации интерфейса и не является трудовым договором.</p>
      </> : <><p className="mt-8">От: {doc.person}</p><p className="mt-5 whitespace-pre-wrap">{doc.description}</p><p className="mt-8">{doc.date}</p></>}
    </div>
  );
}

export function SigningPage() {
  const [docs, setDocs] = React.useState<DemoDocument[]>(() => sessionDocuments);
  React.useEffect(() => { sessionDocuments = docs; }, [docs]);
  const [role, setRole] = React.useState<Role>("hr");
  const [person, setPerson] = React.useState(PEOPLE[0]);
  const [tab, setTab] = React.useState<Tab>("incoming");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [form, setForm] = React.useState<"upload" | "vacation" | null>(null);
  const [notice, setNotice] = React.useState("");
  const [uploadPerson, setUploadPerson] = React.useState(PEOPLE[0]);
  const [file, setFile] = React.useState<File | null>(null);
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState("");
  const selectedDoc = docs.find((doc) => doc.id === selected);
  const own = docs.filter((doc) => doc.person === person);
  const incoming = own.filter((doc) => doc.kind === "contract" && doc.status === "waiting").length;
  const signed = own.filter((doc) => doc.kind === "contract" && doc.status === "signed").length;
  const requests = own.filter((doc) => doc.kind === "vacation").length;
  const visible = docs.filter((doc) => {
    if (role === "employee") {
      if (doc.person !== person) return false;
      if (tab === "incoming") return doc.kind === "contract" && doc.status === "waiting";
      if (tab === "signed") return doc.kind === "contract" && doc.status === "signed";
      return doc.kind === "vacation";
    }
    return (filter === "all" || (doc.kind === "contract" && doc.status === filter) || (filter === "requests" && doc.kind === "vacation")) && `${doc.title} ${doc.person} ${doc.number}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru").trim());
  });
  function switchRole(next: Role) { setRole(next); setSelected(null); setForm(null); setError(""); setNotice(""); }
  function update(id: string, status: Status, label: string) {
    setDocs((current) => current.map((doc) => doc.id === id ? { ...doc, status, description: doc.kind === "vacation" ? doc.description : `${label} в демонстрации.`, events: [{ label, date: today() }, ...doc.events] } : doc));
    setNotice(label + " — демонстрация.");
  }
  function createContract(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || file.type !== "application/pdf") { setError("Выберите файл в формате PDF."); return; }
    const doc: DemoDocument = { id: `demo-${Date.now()}`, title: "Трудовой договор", person: uploadPerson, number: `ДЕМО-${docs.length + 1}`, date: today(), status: "draft", kind: "contract", description: "Договор загружен кадровиком для демонстрации.", file, events: [{ label: "Договор загружен кадровиком", date: today() }] };
    setDocs((current) => [doc, ...current]); setSelected(doc.id); setForm(null); setFile(null); setError(""); setNotice("Черновик создан. Проверьте документ перед отправкой.");
  }
  function createVacation(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!start || !end || end < start) { setError("Укажите даты отпуска: дата окончания не может быть раньше даты начала."); return; }
    const fmt = (value: string) => value.split("-").reverse().join(".");
    const doc: DemoDocument = { id: `demo-${Date.now()}`, title: "Заявление на отпуск", person, number: `ЗАЯВ-${docs.length + 1}`, date: today(), status: "waiting", kind: "vacation", description: `Прошу предоставить отпуск с ${fmt(start)} по ${fmt(end)}.${comment.trim() ? `\n\nКомментарий: ${comment.trim()}` : ""}`, events: [{ label: "Заявление отправлено кадровику", date: today() }] };
    setDocs((current) => [doc, ...current]); setForm(null); setTab("requests"); setSelected(doc.id); setStart(""); setEnd(""); setComment(""); setError(""); setNotice("Заявление отправлено кадровику в демонстрации.");
  }
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-7">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 pb-8">
        <PageHeader title="Подписание документов" subtitle="Документы сотрудников и кадровые заявления" />
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <div className="flex items-start gap-3"><span className="mt-0.5 rounded-lg bg-[var(--info-soft)] p-2 text-[var(--info)]"><FileText size={18} /></span><div><p className="text-sm font-semibold">Демонстрационный режим</p><p className="mt-0.5 text-xs text-[var(--muted-foreground)]">Данные вымышлены. Подписание и отправка имитируются; изменения исчезнут после перезагрузки.</p></div></div>
          <div className="flex rounded-lg bg-[var(--muted)] p-1" aria-label="Выбрать роль">
            <button type="button" onClick={() => switchRole("hr")} aria-pressed={role === "hr"} className={`rounded-md px-3 py-2 text-sm font-semibold ${role === "hr" ? "bg-[var(--card)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>Кадровик</button>
            <button type="button" onClick={() => switchRole("employee")} aria-pressed={role === "employee"} className={`rounded-md px-3 py-2 text-sm font-semibold ${role === "employee" ? "bg-[var(--card)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>Сотрудник</button>
          </div>
        </div>
        {notice && <div role="status" className="rounded-lg bg-[var(--success-soft)] px-4 py-3 text-sm text-[var(--foreground)]">{notice}</div>}
        {role === "employee" && <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-bold">Мои документы</h2><p className="mt-1 text-sm text-[var(--muted-foreground)]">Документы для подписания и ваши заявления</p></div><label className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]"><UserRound size={16} /><span className="sr-only">Сотрудник для демонстрации</span><select value={person} onChange={(e) => { setPerson(e.target.value); setSelected(null); setForm(null); setNotice(""); }} className={`${control} max-w-[290px]`}>{PEOPLE.map((p) => <option key={p}>{p}</option>)}</select></label></div>}
        {form ? (
          <Card className="max-w-2xl p-5 sm:p-7">
            <button type="button" onClick={() => { setForm(null); setError(""); }} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"><ArrowLeft size={16} /> Назад к документам</button>
            {form === "upload" ? <form onSubmit={createContract} className="space-y-5"><div><h2 className="text-lg font-bold">Новый договор</h2><p className="mt-1 text-sm text-[var(--muted-foreground)]">Выберите сотрудника и готовый PDF-файл договора.</p></div><label className="block space-y-2 text-sm font-medium">Получатель<select className={control} value={uploadPerson} onChange={(e) => setUploadPerson(e.target.value)}>{PEOPLE.map((p) => <option key={p}>{p}</option>)}</select></label><label className="block space-y-2 text-sm font-medium">Файл договора<input type="file" accept="application/pdf,.pdf" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(""); }} className="block w-full rounded-lg border border-[var(--border)] p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[var(--muted)] file:px-3 file:py-2 file:font-semibold" /></label><p className="text-xs text-[var(--muted-foreground)]">Файл остаётся в памяти этой страницы. Для демонстрации используйте обезличенный документ.</p>{error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}<Button type="submit"><Upload size={16} /> Создать черновик</Button></form> : <form onSubmit={createVacation} className="space-y-5"><div><h2 className="text-lg font-bold">Заявление на отпуск</h2><p className="mt-1 text-sm text-[var(--muted-foreground)]">Укажите даты, чтобы отправить заявление кадровику.</p></div><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm font-medium">Дата начала<input className={control} type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></label><label className="space-y-2 text-sm font-medium">Дата окончания<input className={control} type="date" value={end} onChange={(e) => setEnd(e.target.value)} required /></label></div><label className="block space-y-2 text-sm font-medium">Комментарий <span className="font-normal text-[var(--muted-foreground)]">необязательно</span><textarea className={`${control} min-h-[96px] py-3`} value={comment} onChange={(e) => setComment(e.target.value)} /></label>{error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}<Button type="submit"><Send size={16} /> Отправить заявление</Button></form>}
          </Card>
        ) : selectedDoc ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3"><button type="button" onClick={() => { setSelected(null); setNotice(""); }} className="inline-flex items-center gap-2 text-sm font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"><ArrowLeft size={16} /> К списку документов</button><StatusLabel status={selectedDoc.status} kind={selectedDoc.kind} /></div>
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
              <Card className="min-w-0 overflow-hidden"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] p-5"><div><h2 className="text-lg font-bold">{selectedDoc.title}</h2><p className="mt-1 text-sm text-[var(--muted-foreground)]">№ {selectedDoc.number} · {selectedDoc.date}</p></div><span className="text-xs font-medium text-[var(--muted-foreground)]">Предпросмотр документа</span></div><div className="bg-[var(--background)] p-4 sm:p-6"><DocumentPreview doc={selectedDoc} /></div></Card>
              <div className="space-y-5"><Card className="p-5"><h3 className="font-semibold">Информация</h3><dl className="mt-4 space-y-4 text-sm"><div><dt className="text-[var(--muted-foreground)]">Сотрудник</dt><dd className="mt-1 font-medium">{selectedDoc.person}</dd></div><div><dt className="text-[var(--muted-foreground)]">Состояние</dt><dd className="mt-1">{selectedDoc.description}</dd></div></dl><div className="mt-5 flex flex-col gap-2">
                {role === "hr" && selectedDoc.kind === "contract" && (selectedDoc.status === "draft" || selectedDoc.status === "attention") && <Button onClick={() => update(selectedDoc.id, "waiting", "Договор отправлен сотруднику на подпись")}><Send size={16} /> Отправить на подпись</Button>}
                {role === "employee" && selectedDoc.kind === "contract" && selectedDoc.status === "waiting" && <><Button onClick={() => update(selectedDoc.id, "signed", "Подписание имитировано")}><Check size={16} /> Имитировать подписание</Button><Button variant="outline" onClick={() => update(selectedDoc.id, "declined", "Сотрудник отказался от подписи")}><XCircle size={16} /> Отказаться от подписи</Button></>}
                {role === "hr" && selectedDoc.kind === "vacation" && selectedDoc.status === "waiting" && <Button onClick={() => update(selectedDoc.id, "accepted", "Заявление принято кадровиком")}><Check size={16} /> Принять заявление</Button>}
              </div></Card><Card className="p-5"><h3 className="font-semibold">История документа</h3><ol className="mt-4 space-y-4">{selectedDoc.events.map((event, index) => <li key={`${event.label}-${index}`} className="flex gap-3 text-sm"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--primary)]" /><div><p>{event.label}</p><p className="mt-1 text-xs text-[var(--muted-foreground)]">{event.date}</p></div></li>)}</ol></Card></div>
            </div>
          </>
        ) : <>
          {role === "hr" ? <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-bold">Документы на подписание</h2><p className="mt-1 text-sm text-[var(--muted-foreground)]">Следите за договорами и заявлениями сотрудников</p></div><Button onClick={() => { setForm("upload"); setNotice(""); }}><Plus size={17} /> Новый договор</Button></div> : <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-1 rounded-lg bg-[var(--muted)] p-1">{([ ["incoming", `На подпись ${incoming}`], ["signed", `Подписанные ${signed}`], ["requests", `Мои заявления ${requests}`] ] as [Tab, string][]).map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setNotice(""); }} className={`rounded-md px-3 py-2 text-sm font-semibold ${tab === value ? "bg-[var(--card)] shadow-sm" : "text-[var(--muted-foreground)]"}`}>{label}</button>)}</div><Button variant="outline" onClick={() => { setForm("vacation"); setNotice(""); }}><FilePlus2 size={16} /> Заявление на отпуск</Button></div>}
          {role === "hr" && <div className="grid gap-3 sm:grid-cols-3"><Card className="flex items-center gap-3 p-4"><Clock3 className="text-[var(--warning)]" size={21} /><div><p className="text-xs text-[var(--muted-foreground)]">Ожидают подписи</p><p className="mt-1 text-xl font-bold">{docs.filter((d) => d.kind === "contract" && d.status === "waiting").length}</p></div></Card><Card className="flex items-center gap-3 p-4"><CheckCircle2 className="text-[var(--success)]" size={21} /><div><p className="text-xs text-[var(--muted-foreground)]">Подписаны</p><p className="mt-1 text-xl font-bold">{docs.filter((d) => d.kind === "contract" && d.status === "signed").length}</p></div></Card><Card className="flex items-center gap-3 p-4"><Inbox className="text-[var(--info)]" size={21} /><div><p className="text-xs text-[var(--muted-foreground)]">Новые заявления</p><p className="mt-1 text-xl font-bold">{docs.filter((d) => d.kind === "vacation" && d.status === "waiting").length}</p></div></Card></div>}
          <Card className="overflow-hidden">{role === "hr" && <div className="flex flex-wrap gap-3 border-b border-[var(--border)] p-4"><label className="relative min-w-[220px] flex-1"><Search size={17} className="absolute left-3 top-3 text-[var(--muted-foreground)]" /><span className="sr-only">Поиск документов</span><input className={`${control} pl-10`} placeholder="Поиск по сотруднику или номеру" value={search} onChange={(e) => setSearch(e.target.value)} /></label><label><span className="sr-only">Фильтр по статусу</span><select className={control} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">Все документы</option><option value="draft">Черновики</option><option value="waiting">Ожидают подписи</option><option value="signed">Подписанные</option><option value="attention">Требуют внимания</option><option value="declined">Отказ от подписи</option><option value="requests">Заявления</option></select></label></div>}
            {visible.length === 0 ? <div className="p-8"><EmptyState title={role === "employee" ? "Здесь пока нет документов" : "Документы не найдены"} description={role === "hr" ? "Измените параметры поиска или создайте договор." : "Когда документ появится, вы увидите его здесь."} /></div> : <div className="divide-y divide-[var(--border)]">{visible.map((doc) => <button type="button" key={doc.id} onClick={() => { setSelected(doc.id); setNotice(""); }} className="group flex w-full flex-wrap items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"><span className="rounded-lg bg-[var(--primary-soft)] p-2.5 text-[var(--primary)]"><FileText size={20} /></span><span className="min-w-[160px] flex-1"><span className="block font-semibold">{doc.title}</span><span className="mt-1 block text-xs text-[var(--muted-foreground)]">{role === "hr" ? `${doc.person} · ` : ""}№ {doc.number} · {doc.date}</span></span><StatusLabel status={doc.status} kind={doc.kind} /><ArrowRight size={17} className="text-[var(--muted-foreground)] group-hover:text-[var(--primary)]" /></button>)}</div>}
          </Card>
        </>}
      </div>
    </div>
  );
}
