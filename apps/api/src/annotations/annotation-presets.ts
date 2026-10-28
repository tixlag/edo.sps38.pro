/** Physical document labels. These definitions deliberately do not mirror ERP requisites. */
import {
  AnnotationFieldKind as K,
  type CreateAnnotationCatalogDto,
} from "./annotation.dto";
const labels: Record<string, string> = {
  series: "Серия",
  number: "Номер",
  last_name: "Фамилия",
  first_name: "Имя",
  middle_name: "Отчество",
  full_name: "Фамилия, имя, отчество",
  birth_date: "Дата рождения",
  birth_place: "Место рождения",
  sex: "Пол",
  citizenship: "Гражданство",
  nationality: "Национальность",
  issued_by: "Кем выдан",
  issue_date: "Дата выдачи",
  expiry_date: "Срок действия",
  department_code: "Код подразделения",
  personal_number: "ПИНФЛ",
  mrz: "Машиночитаемые строки",
  address: "Адрес регистрации",
  registration_date: "Дата регистрации",
  deregistration_date: "Дата снятия с учёта",
  registration_authority: "Орган регистрации",
  photo: "Фотография",
  signature: "Подпись владельца",
  official_signature: "Подпись должностного лица",
  stamp: "Печать или штамп",
  machine_code: "Штрихкод или QR-код",
  last_name_latin: "Фамилия латиницей",
  first_name_latin: "Имя и имена латиницей",
  translator: "Переводчик",
  translation_languages: "Языки перевода",
  notary: "Нотариус",
  notary_district: "Нотариальный округ",
  registry_number: "Реестровый номер",
  certification_date: "Дата удостоверения",
  passport_number: "Серия и номер паспорта",
  passport_issued_by: "Орган выдачи паспорта",
  passport_issue_date: "Дата выдачи паспорта",
  visa_number: "Номер визы",
  purpose: "Цель визита",
  host: "Принимающая сторона",
  host_address: "Адрес принимающей стороны",
  stay_from: "Начало срока пребывания",
  stay_until: "Окончание срока пребывания",
  entry_date: "Дата въезда",
  entry_point: "Пункт въезда",
  service_marks: "Служебные отметки",
  inn: "ИНН",
  tax_authority: "Налоговый орган",
  tax_code: "Код налогового органа",
  snils: "Страховой номер СНИЛС",
  organization: "Организация",
  education_organization: "Учебное заведение",
  document_title: "Наименование документа",
  qualification: "Квалификация",
  specialty: "Специальность или направление",
  specialty_code: "Код специальности",
  decision: "Решение комиссии",
  decision_date: "Дата решения",
  protocol_number: "Номер протокола",
  protocol_date: "Дата протокола",
  profession: "Профессия",
  profession_code: "Код профессии",
  grade: "Разряд",
  study_from: "Начало обучения",
  study_until: "Окончание обучения",
  program: "Программа обучения",
  hours: "Объём часов",
  activity_right: "Право на профессиональную деятельность",
  subject: "Дисциплина или модуль",
  result: "Результат",
  units: "Единицы измерения",
  reference_range: "Референсные значения",
  medical_organization: "Медицинская организация",
  examination: "Обследование или исследование",
  conclusion: "Заключение",
  doctor: "Врач",
  sample_material: "Материал исследования",
  sample_date: "Дата взятия материала",
  examination_date: "Дата исследования",
  indicator: "Исследуемый показатель",
  activity: "Вид деятельности",
  contraindications: "Противопоказания",
  commission: "Состав комиссии",
  level: "Уровень",
  section_result: "Результат раздела экзамена",
  education: "Образование",
  fitness_category: "Категория годности",
  military_rank: "Воинское звание",
  military_composition: "Состав",
  military_specialty: "Военно-учётная специальность",
  reserve_category: "Категория запаса",
  record_date: "Дата записи",
  record: "Содержание записи",
  recipient: "Получатель",
  account: "Номер счёта",
  bank: "Наименование банка",
  bik: "БИК",
  correspondent_account: "Корреспондентский счёт",
  bank_inn: "ИНН банка",
  bank_kpp: "КПП банка",
  residence: "Место жительства",
  category: "Категория",
  category_from: "Начало действия категории",
  category_until: "Окончание действия категории",
  restrictions: "Ограничения и особые отметки",
  certification_center: "Аттестационный центр",
  welder_mark: "Шифр личного клейма",
  welding_process: "Способ сварки",
  certification_scope: "Область аттестации",
  territory: "Территория действия",
  insurer: "Страховая организация",
  policy_type: "Вид полиса",
  insured: "Застрахованное лицо",
  coverage: "Страховое покрытие",
  cargo_tanks: "Классы грузов в цистернах",
  cargo_other: "Классы грузов без цистерн",
  driver_license: "Номер водительского удостоверения",
  valid_from: "Начало действия",
  instructor: "Инструктор",
  spouse1_name: "ФИО первого супруга до брака",
  spouse1_after: "Фамилия первого супруга после брака",
  spouse1_birth_date: "Дата рождения первого супруга",
  spouse1_birth_place: "Место рождения первого супруга",
  spouse1_citizenship: "Гражданство первого супруга",
  spouse2_name: "ФИО второго супруга до брака",
  spouse2_after: "Фамилия второго супруга после брака",
  spouse2_birth_date: "Дата рождения второго супруга",
  spouse2_birth_place: "Место рождения второго супруга",
  spouse2_citizenship: "Гражданство второго супруга",
  marriage_date: "Дата заключения брака",
  act_number: "Номер актовой записи",
  act_date: "Дата актовой записи",
  civil_registry: "Орган ЗАГС",
  father_name: "ФИО отца",
  mother_name: "ФИО матери",
  father_citizenship: "Гражданство отца",
  mother_citizenship: "Гражданство матери",
  former_names: "Прежние фамилии и имена",
  convictions: "Сведения о судимости",
  prosecution: "Сведения об уголовном преследовании",
  record_number: "Номер записи",
  employer: "Работодатель",
  record_basis: "Документ-основание",
  registration_number: "Регистрационный номер",
  official_name: "ФИО должностного лица",
  official_position: "Должность подписанта",
};
const multiline = new Set(
  "full_name last_name first_name middle_name birth_place issued_by address registration_authority mrz host host_address service_marks tax_authority organization education_organization specialty qualification decision program activity_right examination conclusion medical_organization contraindications commission residence certification_center certification_scope restrictions record record_basis employer convictions prosecution former_names civil_registry spouse1_birth_place spouse2_birth_place bank notary_district".split(
    " ",
  ),
);
const kinds: Record<string, K> = {
  photo: K.PHOTO,
  signature: K.SIGNATURE,
  official_signature: K.SIGNATURE,
  stamp: K.STAMP,
  machine_code: K.CODE,
};
type SectionSpec = [string, string, string, boolean?];
function preset(
  code: string,
  profile: string,
  title: string,
  sections: SectionSpec[],
): CreateAnnotationCatalogDto {
  const seen = new Set<string>();
  return {
    documentTypeCode: code,
    profile,
    title,
    sections: sections.map(([key, label, , repeatable], ordinal) => ({
      key,
      label,
      ordinal,
      repeatable: repeatable ?? false,
    })),
    fields: sections.flatMap(([sectionKey, , keys]) =>
      keys
        .split(" ")
        .filter(Boolean)
        .map((key) => {
          const unique = seen.has(key) ? `${sectionKey}_${key}` : key;
          seen.add(unique);
          return {
            key: unique,
            label: labels[key] ?? key,
            ordinal: seen.size - 1,
            sectionKey,
            kind: kinds[key] ?? K.TEXT,
            multiline: multiline.has(key),
            businessFieldName: null,
          };
        }),
    ),
  };
}
const erp = (uid: string) => `ERP_${uid}`;
const main = (keys: string): SectionSpec => [
  "main",
  "Основной документ",
  `${keys} official_name official_position official_signature stamp machine_code`,
];
const edu = (code: string, title: string, keys: string) =>
  preset(code, "STANDARD", title, [
    main(keys),
    [
      "appendix",
      "Приложение: дисциплины и результаты",
      "subject hours result",
      true,
    ],
  ]);
export const ANNOTATION_PRESETS: CreateAnnotationCatalogDto[] = [
  preset("PASSPORT", "RU", "Паспорт России", [
    [
      "main",
      "Основной разворот — страницы 2–3",
      "series number last_name first_name middle_name sex birth_date birth_place issued_by issue_date department_code mrz photo signature official_signature stamp",
    ],
    [
      "registration",
      "Штамп регистрации — страницы 5–12",
      "address registration_date deregistration_date registration_authority department_code official_signature stamp",
      true,
    ],
  ]),
  preset("PASSPORT", "UZ", "Паспорт Узбекистана", [
    [
      "main",
      "Страница персональных данных",
      "series number last_name first_name middle_name last_name_latin first_name_latin citizenship nationality sex birth_date birth_place personal_number issued_by issue_date expiry_date mrz photo signature",
    ],
    [
      "registration",
      "Регистрационная отметка",
      "address registration_date deregistration_date registration_authority official_signature stamp",
      true,
    ],
  ]),
  preset("SNILS", "CARD", "СНИЛС — страховое свидетельство", [
    main(
      "snils last_name first_name middle_name birth_date birth_place sex issue_date",
    ),
  ]),
  preset("SNILS", "ADI_REG", "СНИЛС — уведомление АДИ-РЕГ", [
    main(
      "snils last_name first_name middle_name birth_date birth_place sex registration_date organization",
    ),
  ]),
  preset("INN", "STANDARD", "Свидетельство ИНН", [
    main(
      "full_name sex birth_date birth_place inn registration_date tax_authority tax_code series number issue_date",
    ),
  ]),
  preset("MILITARY", "STANDARD", "Военный билет", [
    main(
      "series number full_name birth_date birth_place issue_date issued_by education profession fitness_category military_rank military_composition military_specialty reserve_category photo signature",
    ),
    [
      "records",
      "Запись воинского учёта или службы",
      "record_date record issued_by stamp official_signature",
      true,
    ],
  ]),
  preset("BANK_DETAILS", "STANDARD", "Реквизиты банка", [
    main(
      "recipient account bank bik correspondent_account bank_inn bank_kpp issue_date",
    ),
  ]),
  preset(
    erp("deb3bcd3-8340-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Водительское удостоверение",
    [
      [
        "front",
        "Лицевая сторона",
        "last_name first_name middle_name birth_date birth_place number issue_date expiry_date issued_by residence photo signature",
      ],
      [
        "categories",
        "Категория — оборотная сторона",
        "category category_from category_until restrictions",
        true,
      ],
      ["back", "Оборотная сторона", "number restrictions machine_code"],
    ],
  ),
  preset(
    erp("a4e4f609-8c6a-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Удостоверение НАКС",
    [
      main(
        "full_name birth_date number certification_center level welder_mark protocol_number protocol_date issue_date expiry_date photo",
      ),
      [
        "scope",
        "Область аттестации",
        "welding_process certification_scope restrictions",
        true,
      ],
    ],
  ),
  preset(
    erp("e6971b86-9120-11eb-ba8c-00259002db81"),
    "STANDARD",
    "Удостоверение машиниста экскаватора",
    [
      main(
        "full_name birth_date series number issued_by issue_date expiry_date profession qualification grade photo signature",
      ),
      [
        "categories",
        "Категория и ограничения",
        "category restrictions protocol_number protocol_date",
        true,
      ],
    ],
  ),
  edu(
    erp("10fa3e03-751b-11ec-80cd-002590854e7f"),
    "Диплом о начальном профессиональном образовании",
    "full_name education_organization document_title series number registration_number issue_date profession specialty qualification grade study_from study_until",
  ),
  preset(
    erp("b6e096a2-87be-11ec-80cf-002590854e7f"),
    "STANDARD",
    "Справка об антителах к кори",
    [
      main(
        "full_name birth_date medical_organization number issue_date sample_material sample_date",
      ),
      [
        "research",
        "Исследование",
        "examination_date indicator result units reference_range conclusion doctor",
        true,
      ],
    ],
  ),
  preset(
    erp("e87d5a10-d248-11eb-80c7-002590854e7f"),
    "STANDARD",
    "Патент на работу",
    [
      [
        "front",
        "Лицевая сторона",
        "series number full_name birth_date citizenship passport_number issue_date photo",
      ],
      [
        "back",
        "Оборотная сторона",
        "profession territory issued_by expiry_date inn official_signature stamp machine_code",
      ],
    ],
  ),
  preset(
    erp("39554ac3-6462-11ec-80cc-002590854e7f"),
    "STANDARD",
    "Миграционная карта",
    [
      [
        "main",
        "Часть миграционной карты",
        "series number last_name first_name middle_name birth_date sex citizenship passport_number visa_number purpose host host_address stay_from stay_until signature",
        true,
      ],
      [
        "marks",
        "Служебная отметка",
        "entry_date entry_point service_marks stamp official_signature",
        true,
      ],
    ],
  ),
  preset(
    erp("26b930ce-6462-11ec-80cc-002590854e7f"),
    "STANDARD",
    "Регистрация по месту пребывания",
    [
      [
        "front",
        "Лицевая сторона",
        "full_name citizenship birth_date passport_number passport_issued_by passport_issue_date address stay_from stay_until",
      ],
      [
        "back",
        "Оборотная сторона и отметка приёма",
        "host host_address registration_date registration_authority signature official_signature stamp machine_code",
      ],
    ],
  ),
  preset(
    erp("90630325-7414-11ec-80cd-002590854e7f"),
    "STANDARD",
    "Сертификат о русском языке",
    [
      main(
        "full_name birth_date citizenship organization series number registration_number issue_date expiry_date level purpose",
      ),
      ["results", "Результат раздела экзамена", "subject section_result", true],
    ],
  ),
  preset(
    erp("6a4dd233-5f52-11ec-80cb-002590854e7f"),
    "STANDARD",
    "Перевод паспорта",
    [
      main(
        "series number last_name first_name middle_name sex birth_date birth_place citizenship personal_number issued_by issue_date expiry_date",
      ),
      [
        "certification",
        "Удостоверение перевода",
        "translator translation_languages notary notary_district registry_number certification_date signature official_signature stamp",
        true,
      ],
    ],
  ),
  edu(
    erp("a18522de-8341-11eb-ba8b-00259002db81"),
    "Диплом о высшем образовании",
    "full_name education_organization series number registration_number issue_date qualification specialty specialty_code decision decision_date",
  ),
  preset(
    erp("ea24dda5-8341-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Заключение психиатрического освидетельствования",
    [
      main(
        "full_name birth_date medical_organization issue_date number activity decision contraindications commission",
      ),
    ],
  ),
  preset(
    erp("70fc9853-8c81-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Свидетельство о браке",
    [
      main(
        "spouse1_name spouse1_after spouse1_birth_date spouse1_birth_place spouse1_citizenship spouse2_name spouse2_after spouse2_birth_date spouse2_birth_place spouse2_citizenship marriage_date act_number act_date civil_registry series number issue_date",
      ),
    ],
  ),
  preset(
    erp("f26b853d-0367-11ef-a9f6-0050560116fc"),
    "STANDARD",
    "Медицинское освидетельствование иностранного гражданина",
    [
      main(
        "full_name birth_date citizenship passport_number medical_organization series number issue_date expiry_date",
      ),
      [
        "research",
        "Заключение или исследование",
        "examination examination_date result conclusion doctor number issue_date official_signature stamp",
        true,
      ],
    ],
  ),
  preset(
    erp("5df73b8f-8c56-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Страховой полис",
    [
      main(
        "policy_type series number insured full_name birth_date citizenship passport_number insurer issue_date valid_from expiry_date territory coverage",
      ),
    ],
  ),
  edu(
    erp("402ec3c2-3cf6-11f0-89f3-00505601221a"),
    "Диплом о профессиональной переподготовке",
    "full_name education_organization program hours study_from study_until qualification activity_right protocol_number protocol_date series number registration_number issue_date",
  ),
  preset(
    erp("5f2d9eef-8341-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Свидетельство ДОПОГ",
    [
      [
        "front",
        "Лицевая сторона",
        "number full_name birth_date citizenship issued_by expiry_date photo signature",
      ],
      [
        "back",
        "Оборотная сторона",
        "cargo_tanks cargo_other issue_date official_signature stamp",
      ],
    ],
  ),
  preset(
    erp("65517702-8341-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Карта тахографа",
    [
      [
        "front",
        "Лицевая сторона",
        "number full_name birth_date issued_by issue_date valid_from expiry_date photo signature",
      ],
      ["back", "Оборотная сторона", "driver_license number machine_code"],
    ],
  ),
  preset(
    erp("9b9cf254-d69d-11ee-a9e4-0050560116fc"),
    "STANDARD",
    "Вид на жительство",
    [
      main(
        "series number full_name citizenship sex birth_date birth_place issued_by issue_date expiry_date photo signature",
      ),
      [
        "registration",
        "Регистрационная отметка",
        "address registration_date deregistration_date registration_authority official_signature stamp",
        true,
      ],
    ],
  ),
  preset(
    erp("7d0a587a-8228-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Защитное и зимнее вождение",
    [
      main(
        "full_name organization program number study_from study_until issue_date expiry_date protocol_number protocol_date result instructor",
      ),
    ],
  ),
  edu(
    erp("bdf50265-5469-11ef-89df-00505601221a"),
    "Свидетельство о профессии",
    "full_name organization profession profession_code qualification grade program hours study_from study_until series number registration_number issue_date protocol_number protocol_date",
  ),
  preset(
    erp("3f164241-8c5b-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Свидетельство о рождении ребёнка",
    [
      main(
        "last_name first_name middle_name sex birth_date birth_place father_name mother_name father_citizenship mother_citizenship act_number act_date civil_registry series number issue_date",
      ),
    ],
  ),
  preset(
    erp("b733d106-8c6b-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Справка об отсутствии судимости",
    [
      main(
        "full_name former_names birth_date birth_place number issue_date issued_by convictions prosecution",
      ),
    ],
  ),
  preset(
    erp("7725d068-8341-11eb-ba8b-00259002db81"),
    "STANDARD",
    "Трудовая книжка",
    [
      main(
        "full_name birth_date education profession series number issue_date signature",
      ),
      [
        "records",
        "Запись о работе или награждении",
        "record_number record_date employer record record_basis official_signature stamp",
        true,
      ],
    ],
  ),
];
export function annotationPreset(code: string, variant?: string) {
  return ANNOTATION_PRESETS.find(
    (p) => p.documentTypeCode === code && (!variant || p.profile === variant),
  );
}
