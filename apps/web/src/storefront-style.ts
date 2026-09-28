import type { Style } from "./types";

export type StorefrontStyle = Required<
  Pick<
    Style,
    | "schemaVersion"
    | "description"
    | "categoryOrder"
    | "themePreset"
    | "colorMode"
    | "coverFocalPoint"
    | "serviceCards"
    | "staffCards"
    | "sectionOrder"
    | "galleryMediaIds"
  >
> &
  Pick<Style, "logoMediaId" | "coverMediaId"> & {
    accent: "violet" | "rose" | "teal" | "amber";
  };

export const DEFAULT_STOREFRONT_STYLE: StorefrontStyle = {
  schemaVersion: 2,
  accent: "violet",
  description: "",
  logoMediaId: null,
  coverMediaId: null,
  categoryOrder: [],
  themePreset: "studio",
  colorMode: "light",
  coverFocalPoint: { x: 50, y: 50 },
  serviceCards: { variant: "compact", showDescription: true },
  staffCards: {
    variant: "compact",
    showDescription: true,
    showRating: true,
  },
  sectionOrder: ["services", "staff", "gallery"],
  galleryMediaIds: [],
};

const accents = new Set(["violet", "rose", "teal", "amber"]);
const presets = new Set(["studio", "editorial", "noir"]);

export function normalizeStyle(value?: Style | null): StorefrontStyle {
  if (!value) return { ...DEFAULT_STOREFRONT_STYLE };
  const order = value.sectionOrder?.filter((section, index, all) =>
    ["services", "staff", "gallery"].includes(section) &&
    all.indexOf(section) === index,
  );
  return {
    ...DEFAULT_STOREFRONT_STYLE,
    ...value,
    schemaVersion: 2,
    accent: accents.has(value.accent)
      ? (value.accent as StorefrontStyle["accent"])
      : "violet",
    themePreset: presets.has(value.themePreset ?? "")
      ? value.themePreset!
      : "studio",
    colorMode: value.colorMode === "dark" ? "dark" : "light",
    coverFocalPoint: {
      x: Math.min(100, Math.max(0, value.coverFocalPoint?.x ?? 50)),
      y: Math.min(100, Math.max(0, value.coverFocalPoint?.y ?? 50)),
    },
    serviceCards: {
      variant: value.serviceCards?.variant === "media" ? "media" : "compact",
      showDescription: value.serviceCards?.showDescription ?? true,
    },
    staffCards: {
      variant: value.staffCards?.variant === "profile" ? "profile" : "compact",
      showDescription: value.staffCards?.showDescription ?? true,
      showRating: value.staffCards?.showRating ?? true,
    },
    sectionOrder:
      order?.length === 3
        ? (order as StorefrontStyle["sectionOrder"])
        : [...DEFAULT_STOREFRONT_STYLE.sectionOrder],
    galleryMediaIds: [...new Set(value.galleryMediaIds ?? [])].slice(0, 8),
    categoryOrder: value.categoryOrder ?? [],
  };
}
