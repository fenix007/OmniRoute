"use client";

import { Input } from "@/shared/components";
import type { ProviderMessageTranslator } from "../../providerPageHelpers";

type ValidationModelInputProps = {
  value: string;
  onChange: (value: string) => void;
  t: ProviderMessageTranslator;
};

export default function ValidationModelInput({ value, onChange, t }: ValidationModelInputProps) {
  return (
    <Input
      label={t("validationModelIdLabel")}
      placeholder={t("validationModelIdPlaceholder")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      hint={t("validationModelIdHint")}
    />
  );
}
