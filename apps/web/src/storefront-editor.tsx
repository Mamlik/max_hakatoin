import { useEffect, useMemo, useState } from "react";
import { api, refreshData, useApi } from "./api";
import { Asset, StorefrontView } from "./personal";
import { LocationPicker } from "./discovery-map";
import { Check, FilePick, Field, Modal, useAction } from "./ui";
import { normalizeStyle, type StorefrontStyle } from "./storefront-style";
import type { Category, DiscoveryProfile, Media, Salon, SalonSocialLink, Service, Staff } from "./types";

const PRESETS = [
  ["studio", "Студия", "Светлая и минималистичная"],
  ["editorial", "Редакция", "Выразительная обложка и ритм"],
  ["noir", "Нуар", "Контрастная и премиальная"],
] as const;
const SECTION_LABELS = {
  services: "Услуги",
  staff: "Мастера",
  gallery: "Галерея",
} as const;
const EMPTY_DISCOVERY: DiscoveryProfile = {
  shortDescription: "", description: "", showMap: false, showHours: true, showGallery: true,
  showRating: true, showLinks: true, address: "", city: "", district: "", metroStations: [], latitude: null, longitude: null,
};

function ChoiceCards<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: readonly (readonly [T, string, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="editor-choice" aria-label={legend}>
      <legend>{legend}</legend>
      <div className="editor-choice-grid">
        {options.map(([id, title, caption]) => (
          <label key={id} className={value === id ? "selected" : ""}>
            <input
              type="radio"
              name={legend}
              checked={value === id}
              onChange={() => onChange(id)}
            />
            <span className={`theme-sample theme-sample-${id}`} aria-hidden="true" />
            <strong>{title}</strong>
            <small>{caption}</small>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function StorefrontEditor({
  tenantId,
  salon,
  draft,
  services,
  staff,
  categories,
  enabled,
}: {
  tenantId: string;
  salon: Salon;
  draft: Salon;
  services: Service[];
  staff: Staff[];
  categories: Category[];
  enabled: boolean;
}) {
  const mapConfig = useApi<{ salonDiscovery?: { editorEnabled?: boolean; geocoderEnabled?: boolean; geocoderProvider?: "nominatim" | "geoapify"; mapStyleLight?: string; mapStyleDark?: string } }>("/config");
  const [style, setStyle] = useState<StorefrontStyle>(() =>
      normalizeStyle(draft.draftStyle),
    ),
    [savedStyle, setSavedStyle] = useState<StorefrontStyle>(() =>
      normalizeStyle(draft.draftStyle),
    ),
    [version, setVersion] = useState(draft.version),
    [media, setMedia] = useState(draft.media ?? []),
    [mobilePreview, setMobilePreview] = useState(false),
    [previewDevice, setPreviewDevice] = useState<"mobile" | "desktop">(
      "mobile",
    );
  const [discovery, setDiscovery] = useState<DiscoveryProfile>(draft.discoveryDraft ?? EMPTY_DISCOVERY);
  const [savedDiscovery, setSavedDiscovery] = useState<DiscoveryProfile>(draft.discoveryDraft ?? EMPTY_DISCOVERY);
  const [socialLinks, setSocialLinks] = useState<SalonSocialLink[]>(draft.socialLinks ?? []);
  const [savedSocialLinks, setSavedSocialLinks] = useState<SalonSocialLink[]>(draft.socialLinks ?? []);
  const action = useAction();
  useEffect(() => {
    const next = normalizeStyle(draft.draftStyle);
    setStyle((current) => {
      const changed = (Object.keys(current) as Array<keyof StorefrontStyle>)
        .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(savedStyle[key]));
      return { ...next, ...Object.fromEntries(changed.map((key) => [key, current[key]])) };
    });
    setSavedStyle(next);
    setVersion(draft.version);
    setMedia(draft.media ?? []);
    const nextDiscovery = draft.discoveryDraft ?? EMPTY_DISCOVERY;
    setDiscovery((current) => {
      const changed = (Object.keys(current) as Array<keyof DiscoveryProfile>)
        .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(savedDiscovery[key]));
      return { ...nextDiscovery, ...Object.fromEntries(changed.map((key) => [key, current[key]])) };
    });
    setSavedDiscovery(nextDiscovery);
    const nextLinks = draft.socialLinks ?? [];
    setSocialLinks((current) => JSON.stringify(current) === JSON.stringify(savedSocialLinks) ? nextLinks : current);
    setSavedSocialLinks(nextLinks);
  }, [draft.version]);
  const hasIncompleteSocialLink = socialLinks.some((link) => !link.url.trim());
  const dirty = useMemo(
    () => JSON.stringify({ style, discovery, socialLinks }) !== JSON.stringify({ style: savedStyle, discovery: savedDiscovery, socialLinks: savedSocialLinks }),
    [style, savedStyle, discovery, savedDiscovery, socialLinks, savedSocialLinks],
  );
  const patch = (next: Partial<StorefrontStyle>) =>
    setStyle((current) => ({ ...current, ...next }));
  const patchDiscovery = (next: Partial<DiscoveryProfile>) =>
    setDiscovery((current) => ({ ...current, ...next }));
  const upload = async (
    purpose: "logo" | "cover" | "gallery",
    file?: File,
  ) => {
    if (!file) return;
    const form = new FormData();
    form.append("purpose", purpose);
    form.append("file", file);
    await action.run(async () => {
      const uploaded = await api<Media>(
        `/work/${tenantId}/media`,
        "POST",
        form,
      );
      setMedia((current) => [
        ...current.filter((item) => item.id !== uploaded.id),
        uploaded,
      ]);
      setStyle((current) =>
        purpose === "gallery"
          ? {
              ...current,
              galleryMediaIds: [...current.galleryMediaIds, uploaded.id].slice(
                0,
                8,
              ),
            }
          : {
              ...current,
              [purpose === "logo" ? "logoMediaId" : "coverMediaId"]:
                uploaded.id,
            },
      );
    }, "Изображение добавлено в черновик");
  };
  const moveSection = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= style.sectionOrder.length) return;
    const order = [...style.sectionOrder];
    [order[index], order[target]] = [order[target]!, order[index]!];
    patch({ sectionOrder: order });
  };
  const moveGallery = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= style.galleryMediaIds.length) return;
    const ids = [...style.galleryMediaIds];
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    patch({ galleryMediaIds: ids });
  };
  const preview = (
    <div className={`editor-device editor-device-${previewDevice}`}>
      <StorefrontView
        salon={{ ...salon, style, media, discoveryProfile: discovery, socialLinks }}
        catalog={{
          services: services.filter((item) => item.active),
          staff: staff.filter((item) => item.active),
          categories,
        }}
        preview
      />
    </div>
  );
  return (
    <section className="panel storefront-editor-panel">
      <div className="editor-toolbar">
        <div>
          <h2>Оформление витрины</h2>
          <p className="editor-save-state" role="status" aria-live="polite">
            {dirty ? "Есть несохранённые изменения" : "Черновик сохранён"}
          </p>
        </div>
        <div className="inline-actions">
          <button
            className="button secondary editor-mobile-preview"
            onClick={() => setMobilePreview(true)}
          >
            Предпросмотр
          </button>
          <button
            className="button primary"
            disabled={action.busy || !dirty || hasIncompleteSocialLink}
            onClick={() =>
              void action.run(async () => {
                const saved = await api<{ version: number }>(
                  `/work/${tenantId}/storefront/draft`,
                  "PUT",
                  {
                    expectedVersion: version,
                    style,
                    ...(mapConfig.data?.salonDiscovery?.editorEnabled !== false ? {
                      discovery,
                      socialLinks: socialLinks.map(({ id, kind, url, label, sortOrder }) => ({ id, kind, url, label, sortOrder })),
                    } : {}),
                  },
                );
                setVersion(saved.version);
                setSavedStyle(style);
                setSavedDiscovery(discovery);
                setSavedSocialLinks(socialLinks);
                refreshData();
              }, "Черновик сохранён")
            }
          >
            Сохранить черновик
          </button>
          <button
            className="button secondary"
            disabled={action.busy || dirty}
            onClick={() =>
              void action.run(async () => {
                const published = await api<{ version: number }>(
                  `/work/${tenantId}/storefront/publish`,
                  "POST",
                  { expectedVersion: version },
                );
                setVersion(published.version);
                refreshData();
              }, "Оформление опубликовано")
            }
          >
            Опубликовать
          </button>
        </div>
      </div>
      {!enabled && (
        <div className="notice">
          Расширенные темы отключены feature flag. Публичная витрина использует
          совместимый базовый шаблон.
        </div>
      )}
      <div className="storefront-editor-layout">
        <div className="storefront-editor-controls">
          {mapConfig.data?.salonDiscovery?.editorEnabled !== false && <section className="discovery-editor-section" aria-labelledby="discovery-editor-title">
            <div className="section-head"><div><h3 id="discovery-editor-title">Профиль для каталога</h3><p>Информация, по которой вас найдут и выберут.</p></div></div>
            <Field label="Коротко о салоне" hint="До 160 символов. Показывается в поиске."><textarea rows={2} maxLength={160} value={discovery.shortDescription} onChange={(event) => patchDiscovery({ shortDescription: event.target.value })} /></Field>
            <Field label="Описание салона" hint="До 1500 символов."><textarea rows={5} maxLength={1500} value={discovery.description} onChange={(event) => patchDiscovery({ description: event.target.value })} /></Field>
            <div className="discovery-editor-location">
              <strong>Адрес и расположение</strong>
              <p>Точный адрес и точка появятся в каталоге только после проверки координат и включения показа на карте.</p>
              <Field label="Точный адрес"><input maxLength={300} value={discovery.address} onChange={(event) => patchDiscovery({ address: event.target.value })} placeholder="Улица, дом, помещение" /></Field>
              <div className="two-columns"><Field label="Город"><input maxLength={120} value={discovery.city} onChange={(event) => patchDiscovery({ city: event.target.value })} /></Field><Field label="Район"><input maxLength={120} value={discovery.district} onChange={(event) => patchDiscovery({ district: event.target.value })} /></Field></div>
              <Field label="Станции метро" hint="До 3 станций через запятую."><input value={discovery.metroStations.join(", ")} onChange={(event) => patchDiscovery({ metroStations: [...new Set(event.target.value.split(",").map((value) => value.trim()).filter(Boolean))].slice(0, 3) })} placeholder="Пушкинская, Чеховская" /></Field>
              <div className="two-columns"><Field label="Широта"><input inputMode="decimal" type="number" min="-90" max="90" step="0.000001" value={discovery.latitude ?? ""} onChange={(event) => patchDiscovery({ latitude: event.target.value ? Number(event.target.value) : null })} placeholder="55.7558" /></Field><Field label="Долгота"><input inputMode="decimal" type="number" min="-180" max="180" step="0.000001" value={discovery.longitude ?? ""} onChange={(event) => patchDiscovery({ longitude: event.target.value ? Number(event.target.value) : null })} placeholder="37.6173" /></Field></div>
              <><span className="small muted">Найдите адрес, нажмите на карте или перетащите пин. Координаты сохраняются в черновике и появятся в каталоге после проверки.</span><LocationPicker
                tenantId={tenantId}
                geocoderEnabled={mapConfig.data?.salonDiscovery?.geocoderEnabled === true}
                geocoderProvider={mapConfig.data?.salonDiscovery?.geocoderProvider}
                styles={{ light: mapConfig.data?.salonDiscovery?.mapStyleLight, dark: mapConfig.data?.salonDiscovery?.mapStyleDark }}
                latitude={discovery.latitude}
                longitude={discovery.longitude}
                address={discovery.address}
                city={discovery.city}
                onPick={(latitude, longitude) => patchDiscovery({ latitude, longitude })}
                onAddressResolved={(address) => patchDiscovery({ address })}
              /></>
              <p className={`discovery-review-state ${draft.discoveryDraft?.geoStatus === "verified" ? "approved" : "pending"}`} role="status">{draft.discoveryDraft?.geoStatus === "verified" ? "Точка подтверждена модератором" : discovery.latitude !== null && discovery.longitude !== null ? "Точка будет проверена перед публикацией" : "Точка на карте пока не задана"}</p>
              <Check label="Показывать салон на карте и точный адрес" checked={discovery.showMap} onChange={(showMap) => patchDiscovery({ showMap })} />
            </div>
            <div className="discovery-editor-visibility"><strong>Что показывать посетителям</strong><Check label="Часы работы" checked={discovery.showHours} onChange={(showHours) => patchDiscovery({ showHours })} /><Check label="Фотогалерею" checked={discovery.showGallery} onChange={(showGallery) => patchDiscovery({ showGallery })} /><Check label="Рейтинг салона (после 3 оценок)" checked={discovery.showRating} onChange={(showRating) => patchDiscovery({ showRating })} /><Check label="Ссылки и соцсети" checked={discovery.showLinks} onChange={(showLinks) => patchDiscovery({ showLinks })} /></div>
            {discovery.showLinks && <div className="discovery-editor-links">
              <div className="section-head"><strong>Ссылки</strong><small>{socialLinks.length}/7</small></div>
              {socialLinks.map((link, index) => <div className="discovery-link-editor" key={link.id ?? `new-${index}`}>
                <label className="field"><span>Тип</span><select value={link.kind} onChange={(event) => setSocialLinks((current) => current.map((item, i) => i === index ? { ...item, kind: event.target.value as SalonSocialLink["kind"], validationStatus: undefined } : item))}><option value="website">Сайт</option><option value="max">MAX</option><option value="vk">ВКонтакте</option><option value="telegram">Telegram</option><option value="instagram">Instagram</option><option value="tiktok">TikTok</option><option value="other">Другая ссылка · проверка модератором</option></select></label>
                <label className="field"><span>Ссылка</span><input type="url" inputMode="url" value={link.url} onChange={(event) => setSocialLinks((current) => current.map((item, i) => i === index ? { ...item, url: event.target.value, validationStatus: undefined } : item))} placeholder="https://…" /></label>
                <div className="discovery-link-bottom"><input aria-label="Подпись ссылки" maxLength={40} value={link.label} onChange={(event) => setSocialLinks((current) => current.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} placeholder="Подпись (необязательно)" /><button type="button" className="text-button danger-text" aria-label={`Удалить ссылку ${index + 1}`} onClick={() => setSocialLinks((current) => current.filter((_, i) => i !== index))}>Убрать</button></div>
                {!link.url.trim() && <small className="discovery-link-status" role="status">Добавьте ссылку или удалите эту строку, чтобы сохранить черновик.</small>}
                <small className={`discovery-link-status ${link.validationStatus === "approved" ? "approved" : ""}`}>{link.validationStatus === "approved" ? "Проверена" : link.validationStatus === "rejected" ? "Отклонена — исправьте ссылку" : link.kind === "other" ? "Появится после проверки модератором" : "Будет автоматически проверена при сохранении"}</small>
              </div>)}
              <button type="button" className="button secondary" disabled={socialLinks.length >= 7} onClick={() => setSocialLinks((current) => [...current, { kind: "website", url: "", label: "", sortOrder: current.length }])}>Добавить ссылку</button>
            </div>}
          </section>}
          {enabled && (
            <>
              <ChoiceCards
                legend="Тема оформления"
                value={style.themePreset}
                options={PRESETS}
                onChange={(themePreset) => patch({ themePreset })}
              />
              <div className="editor-row">
                <ChoiceCards
                  legend="Режим"
                  value={style.colorMode}
                  options={[
                    ["light", "Светлый", "Белые поверхности"],
                    ["dark", "Тёмный", "Тёмные поверхности"],
                  ]}
                  onChange={(colorMode) => patch({ colorMode })}
                />
              </div>
              <div className="editor-row two-columns">
                <ChoiceCards
                  legend="Карточки услуг"
                  value={style.serviceCards.variant}
                  options={[
                    ["compact", "Компактные", "Цена справа"],
                    ["media", "С фото", "Крупнее и нагляднее"],
                  ]}
                  onChange={(variant) =>
                    patch({
                      serviceCards: { ...style.serviceCards, variant },
                    })
                  }
                />
                <Check
                  label="Показывать описание услуги"
                  checked={style.serviceCards.showDescription}
                  onChange={(showDescription) =>
                    patch({
                      serviceCards: { ...style.serviceCards, showDescription },
                    })
                  }
                />
                <ChoiceCards
                  legend="Карточки мастеров"
                  value={style.staffCards.variant}
                  options={[
                    ["compact", "Компактные", "Фото, имя и рейтинг"],
                    ["profile", "Расширенные", "Описание и крупное фото"],
                  ]}
                  onChange={(variant) =>
                    patch({ staffCards: { ...style.staffCards, variant } })
                  }
                />
                <Check
                  label="Показывать описание мастера"
                  checked={style.staffCards.showDescription}
                  onChange={(showDescription) =>
                    patch({
                      staffCards: { ...style.staffCards, showDescription },
                    })
                  }
                />
                <Check
                  label="Показывать рейтинг мастера"
                  checked={style.staffCards.showRating}
                  onChange={(showRating) =>
                    patch({ staffCards: { ...style.staffCards, showRating } })
                  }
                />
              </div>
            </>
          )}
          <Field label="Описание">
            <textarea
              rows={4}
              value={style.description}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </Field>
          <Field label="Акцентный цвет">
            <div className="palette">
              {(["violet", "rose", "teal", "amber"] as const).map(
                (color) => (
                  <button
                    type="button"
                    key={color}
                    className={`swatch ${color} ${style.accent === color ? "selected" : ""}`}
                    aria-label={`Акцент ${color}`}
                    aria-pressed={style.accent === color}
                    onClick={() => patch({ accent: color })}
                  >
                    {style.accent === color ? "✓" : ""}
                  </button>
                ),
              )}
            </div>
          </Field>
          {enabled && (
            <Field label="Порядок разделов">
              <div className="category-order">
                {style.sectionOrder.map((section, index) => (
                  <div key={section}>
                    <span>{SECTION_LABELS[section]}</span>
                    <button
                      className="text-button"
                      aria-label={`${SECTION_LABELS[section]} выше`}
                      disabled={index === 0}
                      onClick={() => moveSection(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="text-button"
                      aria-label={`${SECTION_LABELS[section]} ниже`}
                      disabled={index === style.sectionOrder.length - 1}
                      onClick={() => moveSection(index, 1)}
                    >
                      ↓
                    </button>
                  </div>
                ))}
              </div>
            </Field>
          )}
          <div className="editor-media-grid">
            <Field
              label="Логотип"
              hint="JPEG, PNG или WebP до 5 МБ. Метаданные удаляются."
            >
              <FilePick
                accept="image/jpeg,image/png,image/webp"
                disabled={action.busy}
                onPick={(file) => void upload("logo", file)}
                label="Выбрать логотип"
              />
              {style.logoMediaId && (
                <span className="small success-text">Логотип выбран</span>
              )}
            </Field>
            <Field label="Обложка" hint="Рекомендуемое соотношение 16:9.">
              <FilePick
                accept="image/jpeg,image/png,image/webp"
                disabled={action.busy}
                onPick={(file) => void upload("cover", file)}
                label="Выбрать обложку"
              />
              {style.coverMediaId && (
                <span className="small success-text">Обложка выбрана</span>
              )}
            </Field>
          </div>
          {enabled && (
            <>
              <fieldset className="focal-field">
                <legend>Фокус обложки</legend>
                <label>
                  По горизонтали
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={style.coverFocalPoint.x}
                    onChange={(event) =>
                      patch({
                        coverFocalPoint: {
                          ...style.coverFocalPoint,
                          x: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  По вертикали
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={style.coverFocalPoint.y}
                    onChange={(event) =>
                      patch({
                        coverFocalPoint: {
                          ...style.coverFocalPoint,
                          y: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <button
                  className="text-button"
                  onClick={() => patch({ coverFocalPoint: { x: 50, y: 50 } })}
                >
                  Сбросить по центру
                </button>
              </fieldset>
              <Field label="Галерея" hint="До 8 изображений, 4:3.">
                <FilePick
                  accept="image/jpeg,image/png,image/webp"
                  disabled={action.busy || style.galleryMediaIds.length >= 8}
                  onPick={(file) => void upload("gallery", file)}
                  label="Добавить фото"
                />
              </Field>
              {style.galleryMediaIds.length > 0 && (
                <div className="gallery-editor" aria-label="Изображения галереи">
                  {style.galleryMediaIds.map((id, index) => (
                    <div key={id}>
                      <Asset
                        tenantId={tenantId}
                        media={media.find((item) => item.id === id)}
                        privateAsset
                        alt={`Фото галереи ${index + 1}`}
                      />
                      <div>
                        <button
                          className="text-button"
                          aria-label={`Фото ${index + 1} левее`}
                          disabled={index === 0}
                          onClick={() => moveGallery(index, -1)}
                        >
                          ←
                        </button>
                        <button
                          className="text-button"
                          aria-label={`Фото ${index + 1} правее`}
                          disabled={index === style.galleryMediaIds.length - 1}
                          onClick={() => moveGallery(index, 1)}
                        >
                          →
                        </button>
                        <button
                          className="text-button danger-text"
                          aria-label={`Убрать фото ${index + 1}`}
                          onClick={() =>
                            patch({
                              galleryMediaIds: style.galleryMediaIds.filter(
                                (mediaId) => mediaId !== id,
                              ),
                            })
                          }
                        >
                          Убрать
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <Field label="Порядок категорий">
            <div className="category-order">
              {(style.categoryOrder.length
                ? style.categoryOrder
                : categories.map((category) => category.id)
              ).map((id, index, all) => (
                <div key={id}>
                  <span>
                    {categories.find((category) => category.id === id)?.name ??
                      "Категория"}
                  </span>
                  <button
                    className="text-button"
                    disabled={index === 0}
                    onClick={() => {
                      const order = [...all];
                      [order[index - 1], order[index]] = [
                        order[index]!,
                        order[index - 1]!,
                      ];
                      patch({ categoryOrder: order });
                    }}
                  >
                    ↑
                  </button>
                  <button
                    className="text-button"
                    disabled={index === all.length - 1}
                    onClick={() => {
                      const order = [...all];
                      [order[index + 1], order[index]] = [
                        order[index]!,
                        order[index + 1]!,
                      ];
                      patch({ categoryOrder: order });
                    }}
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>
          </Field>
        </div>
        <aside className="storefront-editor-preview" aria-label="Живой предпросмотр">
          <div className="preview-head">
            <div>
              <strong>Живой предпросмотр</strong>
              <small>Показывает текущий черновик</small>
            </div>
            <div className="preview-switch" role="group" aria-label="Размер предпросмотра">
              <button
                aria-pressed={previewDevice === "mobile"}
                onClick={() => setPreviewDevice("mobile")}
              >
                Мобильный
              </button>
              <button
                aria-pressed={previewDevice === "desktop"}
                onClick={() => setPreviewDevice("desktop")}
              >
                Desktop
              </button>
            </div>
          </div>
          {preview}
        </aside>
      </div>
      {action.feedback}
      {mobilePreview && (
        <Modal title="Предпросмотр витрины" onClose={() => setMobilePreview(false)}>
          {preview}
        </Modal>
      )}
    </section>
  );
}
