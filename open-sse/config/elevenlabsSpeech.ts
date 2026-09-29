import { z } from "zod";

// https://elevenlabs.io/docs/api-reference/text-to-speech/convert
const outputFormats = [
  "alaw_8000",
  "mp3_22050_32",
  "mp3_24000_48",
  "mp3_44100_128",
  "mp3_44100_192",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "opus_48000_128",
  "opus_48000_192",
  "opus_48000_32",
  "opus_48000_64",
  "opus_48000_96",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_32000",
  "pcm_44100",
  "pcm_48000",
  "pcm_8000",
  "ulaw_8000",
  "wav_16000",
  "wav_22050",
  "wav_24000",
  "wav_32000",
  "wav_44100",
  "wav_48000",
  "wav_8000",
] as const;

const v4VoiceSettingsSchema = z
  .object({
    stability: z.number().min(0).max(1).optional(),
    similarity_boost: z.number().min(0).max(1).optional(),
  })
  .strict();

const legacyVoiceSettingsSchema = v4VoiceSettingsSchema.extend({
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
  use_speaker_boost: z.boolean().optional(),
});

const speechOptionsSchema = z.object({
  input: z.string().min(1),
  voice_settings: legacyVoiceSettingsSchema.nullable().optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
  language_code: z
    .string()
    .regex(/^[a-z]{2,3}$/)
    .nullable()
    .optional(),
  output_format: z.enum(outputFormats).optional(),
  response_format: z.string().optional(),
  seed: z.number().int().min(0).max(4294967295).nullable().optional(),
  previous_text: z.string().nullable().optional(),
  next_text: z.string().nullable().optional(),
  apply_text_normalization: z.enum(["auto", "on", "off"]).optional(),
});

const responseFormats: Record<string, { format: string; contentType: string }> = {
  mp3: { format: "mp3_44100_128", contentType: "audio/mpeg" },
  opus: { format: "opus_48000_128", contentType: "audio/ogg" },
  pcm: { format: "pcm_24000", contentType: "audio/pcm" },
  wav: { format: "wav_24000", contentType: "audio/wav" },
};

type SpeechRequest = {
  text: string;
  model_id: string;
  voice_settings?: z.infer<typeof legacyVoiceSettingsSchema>;
  language_code?: string;
  seed?: number;
  previous_text?: string;
  next_text?: string;
  apply_text_normalization?: "auto" | "on" | "off";
};

export function buildElevenLabsSpeechRequest(
  body: unknown,
  modelId: string
): { error: string } | { payload: SpeechRequest; outputFormat?: string; contentType: string } {
  const parsed = speechOptionsSchema.safeParse(body);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") || "request";
    return { error: `Invalid ElevenLabs speech parameter: ${path}` };
  }
  const options = parsed.data;
  const isV4 = modelId === "eleven_v4" || modelId === "eleven_v4_turbo";
  if (modelId === "eleven_v4" && options.input.length > 10000) {
    return { error: "Eleven v4 input must not exceed 10000 characters" };
  }
  // v4 has only Stability and Similarity; never silently promise speed/style control.
  if (
    isV4 &&
    (!v4VoiceSettingsSchema.safeParse(options.voice_settings ?? {}).success ||
      (options.speed !== undefined && options.speed !== 1))
  ) {
    return {
      error:
        "Eleven v4 supports only stability and similarity_boost voice settings; speed is not supported",
    };
  }

  const mappedFormat =
    options.response_format && Object.hasOwn(responseFormats, options.response_format)
      ? responseFormats[options.response_format]
      : undefined;
  if (!options.output_format && options.response_format && !mappedFormat) {
    return {
      error: "Unsupported ElevenLabs response_format; use mp3, opus, pcm, wav or output_format",
    };
  }
  const outputFormat = options.output_format ?? mappedFormat?.format;
  const codec = outputFormat?.split("_")[0] ?? "mp3";
  const contentType = responseFormats[codec]?.contentType ?? "application/octet-stream";

  const payload: SpeechRequest = { text: options.input, model_id: modelId };
  if (options.voice_settings) payload.voice_settings = { ...options.voice_settings };
  if (!isV4 && options.speed !== undefined) {
    payload.voice_settings = {
      ...payload.voice_settings,
      speed: payload.voice_settings?.speed ?? options.speed,
    };
  }
  // Multilingual v2 rejects language_code, unlike v4 and Turbo v2.5.
  if (options.language_code && modelId !== "eleven_multilingual_v2") {
    payload.language_code = options.language_code;
  }
  if (options.seed != null) payload.seed = options.seed;
  if (options.previous_text != null) payload.previous_text = options.previous_text;
  if (options.next_text != null) payload.next_text = options.next_text;
  if (options.apply_text_normalization !== undefined) {
    payload.apply_text_normalization = options.apply_text_normalization;
  }
  return { payload, outputFormat, contentType };
}
