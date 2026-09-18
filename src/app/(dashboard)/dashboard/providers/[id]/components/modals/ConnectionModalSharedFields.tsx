"use client";

import type { ProviderMessageTranslator } from "../../providerPageHelpers";
import GlmTeamQuotaFields, { type GlmTeamQuotaFieldValues } from "./GlmTeamQuotaFields";

type AdvancedSettingsToggleProps = {
  expanded: boolean;
  controls: string;
  onToggle: () => void;
  label: string;
};

export function AdvancedSettingsToggle({
  expanded,
  controls,
  onToggle,
  label,
}: AdvancedSettingsToggleProps) {
  return (
    <button
      type="button"
      className="text-sm text-text-muted hover:text-text-primary flex items-center gap-1"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controls}
    >
      <span className={`transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true">
        ▶
      </span>
      {label}
    </button>
  );
}

type GlmConnectionFieldsProps = {
  values: GlmTeamQuotaFieldValues & { apiRegion: string };
  onChange: (patch: Partial<GlmTeamQuotaFieldValues & { apiRegion: string }>) => void;
  t: ProviderMessageTranslator;
};

export function GlmConnectionFields({ values, onChange, t }: GlmConnectionFieldsProps) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="text-sm font-medium text-text-main mb-1 block">
          {t("apiRegionLabel")}
        </label>
        <select
          value={values.apiRegion}
          onChange={(e) => onChange({ apiRegion: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
        >
          <option value="international">{t("apiRegionInternational")}</option>
          <option value="china">{t("apiRegionChina")}</option>
        </select>
        <p className="text-xs text-text-muted mt-1">{t("apiRegionHint")}</p>
      </div>
      <GlmTeamQuotaFields values={values} onChange={onChange} t={t} />
    </div>
  );
}
