"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type ControllerRenderProps } from "react-hook-form";
import { z } from "zod";
import { Loader2, Bot, Info } from "lucide-react";
import { toast } from "sonner";
import { api } from "@vitalora/api-client";
import type { Clinic, Receptionist } from "@vitalora/shared-types";
import { SUPPORTED_LANGUAGES } from "@vitalora/shared-types";

import { cn } from "@/lib/utils";
import { mapApiError } from "@/lib/utils-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

/**
 * The backend EscalationConfig also carries `enabled` + `contact_method`
 * (scheduling hints not yet editable in the UI). We preserve them verbatim
 * on update so a save never silently resets them.
 */
type EscalationFull = NonNullable<Receptionist["escalation"]> & {
  enabled?: boolean;
  contact_method?: "transfer" | "callback";
};

const VOICES = [
  "tongtong",
  "chuichui",
  "xiaochen",
  "jam",
  "kazi",
  "douji",
  "luodo",
] as const;

const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code) as [string, ...string[]];

const receptionistSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters.")
      .max(120, "Name must be at most 120 characters."),
    clinic_id: z.string().min(1, "Choose the clinic this receptionist serves."),
    persona: z.string().trim().max(2000, "Persona must be at most 2000 characters.").optional(),
    languages: z
      .array(z.enum(LANGUAGE_CODES))
      .min(1, "Select at least one language."),
    primary_language: z.enum(LANGUAGE_CODES),
    voice_id: z.enum(VOICES),
    speaking_speed: z
      .number({ message: "Speaking speed is required." })
      .min(0.5, "Speed must be between 0.5 and 2.0.")
      .max(2.0, "Speed must be between 0.5 and 2.0."),
    greeting_message: z
      .string()
      .trim()
      .max(1000, "Greeting must be at most 1000 characters.")
      .optional(),
    system_prompt_extra: z
      .string()
      .trim()
      .max(4000, "Instructions must be at most 4000 characters.")
      .optional(),
    capabilities: z.object({
      booking: z.boolean(),
      knowledge_qa: z.boolean(),
      callback_requests: z.boolean(),
    }),
    escalation: z.object({
      transfer_message: z.string().trim().max(500, "Max 500 characters.").optional(),
      callback_number: z.string().trim().max(40, "Max 40 characters.").optional(),
      emergency_guidance: z.string().trim().max(500, "Max 500 characters.").optional(),
    }),
  })
  .refine((v) => v.languages.includes(v.primary_language), {
    message: "The primary language must be one of the selected languages.",
    path: ["primary_language"],
  });

type ReceptionistValues = z.infer<typeof receptionistSchema>;

function defaultFormValues(
  receptionist?: Receptionist | null
): ReceptionistValues {
  return {
    name: receptionist?.name ?? "",
    clinic_id: receptionist?.clinic_id ?? "",
    persona: receptionist?.persona ?? "",
    languages: receptionist?.languages?.length ? receptionist.languages : ["en"],
    primary_language: receptionist?.primary_language ?? "en",
    voice_id: (receptionist?.voice_id as ReceptionistValues["voice_id"]) ?? "tongtong",
    speaking_speed: receptionist?.speaking_speed ?? 1.0,
    greeting_message: receptionist?.greeting_message ?? "",
    system_prompt_extra: receptionist?.system_prompt_extra ?? "",
    capabilities: receptionist?.capabilities ?? {
      booking: true,
      knowledge_qa: true,
      callback_requests: true,
    },
    escalation: {
      transfer_message: receptionist?.escalation?.transfer_message ?? "",
      callback_number: receptionist?.escalation?.callback_number ?? "",
      emergency_guidance: receptionist?.escalation?.emergency_guidance ?? "",
    },
  };
}

/**
 * ReceptionistDialog — create or edit an AI receptionist. Mirrors the
 * backend validation (name 2–120, languages ⊆ SUPPORTED_LANGUAGES with
 * primary ∈ languages, voice_id literal, speed 0.5–2.0, field max lengths).
 */
export function ReceptionistDialog({
  open,
  onOpenChange,
  receptionist,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing receptionist. */
  receptionist?: Receptionist | null;
  onSaved?: (saved: Receptionist) => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(receptionist);

  const clinicsQuery = useQuery({
    queryKey: ["clinics"],
    queryFn: () => api.listClinics(),
    enabled: open,
  });
  const clinics = clinicsQuery.data?.items ?? [];

  const form = useForm<ReceptionistValues>({
    resolver: zodResolver(receptionistSchema),
    defaultValues: defaultFormValues(receptionist),
  });

  // Re-seed the form whenever a different receptionist is opened for edit.
  React.useEffect(() => {
    if (open) {
      form.reset(defaultFormValues(receptionist));
    }
  }, [open, receptionist, form]);

  const mutation = useMutation({
    mutationFn: async (values: ReceptionistValues) => {
      const escalation: EscalationFull = {
        enabled: (receptionist?.escalation as EscalationFull | undefined)?.enabled ?? false,
        contact_method:
          (receptionist?.escalation as EscalationFull | undefined)?.contact_method ?? "callback",
        transfer_message: values.escalation.transfer_message || undefined,
        callback_number: values.escalation.callback_number || undefined,
        emergency_guidance: values.escalation.emergency_guidance || undefined,
      };
      if (isEdit && receptionist) {
        return api.updateReceptionist(receptionist.id, {
          name: values.name,
          persona: values.persona || undefined,
          languages: values.languages,
          primary_language: values.primary_language,
          voice_id: values.voice_id,
          speaking_speed: values.speaking_speed,
          greeting_message: values.greeting_message || undefined,
          system_prompt_extra: values.system_prompt_extra || undefined,
          capabilities: values.capabilities,
          escalation,
        });
      }
      return api.createReceptionist({
        clinic_id: values.clinic_id,
        name: values.name,
        persona: values.persona || undefined,
        languages: values.languages,
        primary_language: values.primary_language,
        voice_id: values.voice_id,
        speaking_speed: values.speaking_speed,
        greeting_message: values.greeting_message || undefined,
        system_prompt_extra: values.system_prompt_extra || undefined,
        capabilities: values.capabilities,
        escalation,
      });
    },
    onSuccess: (saved) => {
      toast.success(
        isEdit
          ? `Receptionist “${saved.name}” saved.`
          : `Receptionist “${saved.name}” created as a draft — activate it when ready.`
      );
      void queryClient.invalidateQueries({ queryKey: ["receptionists"] });
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (error) => toast.error(mapApiError(error)),
  });

  const languagesValue = form.watch("languages");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-primary" aria-hidden="true" />
            {isEdit ? `Edit receptionist — ${receptionist?.name}` : "New AI receptionist"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Changes apply to every new conversation this receptionist handles."
              : "New receptionists start in draft and only answer calls once activated."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-5" noValidate>
          {/* Identity */}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Ayesha — Front Desk" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="clinic_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Clinic *</FormLabel>
                  {clinicsQuery.isPending ? (
                    <Skeleton className="h-11 w-full rounded-md" />
                  ) : clinics.length === 0 ? (
                    <p role="alert" className="text-sm text-destructive">
                      No clinics available. Create a clinic in Settings first.
                    </p>
                  ) : (
                    <Select value={field.value || undefined} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="min-h-11 w-full">
                          <SelectValue placeholder="Select a clinic" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {clinics.map((c: Clinic) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="persona"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Persona</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="e.g. Warm, concise dental front-desk assistant who speaks plainly and reassures nervous patients."
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>
                  How the receptionist should sound and behave. Max 2000 characters.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <Separator />

          {/* Languages */}
          <FormField
            control={form.control}
            name="languages"
            render={({ field }: { field: ControllerRenderProps<ReceptionistValues, "languages"> }) => (
              <FormItem>
                <FormLabel>Languages *</FormLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {SUPPORTED_LANGUAGES.map((lang) => {
                    const checked = field.value.includes(lang.code);
                    return (
                      <Label
                        key={lang.code}
                        className={cn(
                          "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-normal",
                          checked && "border-primary/50 bg-primary/5"
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => {
                            const next = v
                              ? [...field.value, lang.code]
                              : field.value.filter((c) => c !== lang.code);
                            // Never allow an empty set; primary must stay valid.
                            const safeNext = next.length > 0 ? next : [lang.code];
                            field.onChange(safeNext);
                            const primary = form.getValues("primary_language");
                            if (!safeNext.includes(primary)) {
                              form.setValue("primary_language", safeNext[0] ?? "en", {
                                shouldValidate: true,
                              });
                            }
                          }}
                          aria-label={`Speak ${lang.label}`}
                        />
                        <span className="truncate">{lang.label}</span>
                      </Label>
                    );
                  })}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="primary_language"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Primary language *</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="min-h-11 w-full">
                        <SelectValue placeholder="Select primary language" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(languagesValue.length > 0 ? languagesValue : ["en"]).map((code) => {
                        const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
                        return (
                          <SelectItem key={code} value={code}>
                            {lang?.label ?? code}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <FormDescription>Used for greetings and fallbacks.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="voice_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Voice *</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="min-h-11 w-full">
                        <SelectValue placeholder="Select a voice" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {VOICES.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    <Info className="mb-0.5 inline size-3" aria-hidden="true" /> Voice previews are
                    available in the Voice Lab.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="speaking_speed"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Speaking speed — {field.value.toFixed(1)}×</FormLabel>
                <FormControl>
                  <Slider
                    min={0.5}
                    max={2.0}
                    step={0.1}
                    value={[field.value]}
                    onValueChange={(v) => field.onChange(v[0] ?? 1)}
                    aria-label="Speaking speed"
                  />
                </FormControl>
                <FormDescription>0.5× (slowest) to 2.0× (fastest).</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <Separator />

          {/* Script */}
          <FormField
            control={form.control}
            name="greeting_message"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Greeting message</FormLabel>
                <FormControl>
                  <Textarea
                    rows={2}
                    placeholder="e.g. Assalam-o-Alaikum! Welcome to Vitalora Dental — how may I help you today?"
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>Said at the start of every call. Max 1000 characters.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="system_prompt_extra"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Extra system instructions</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="Clinic-specific rules, e.g. always mention the follow-up fee, never give dosage advice."
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>Max 4000 characters. Combined with the persona.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <Separator />

          {/* Capabilities */}
          <div>
            <p className="text-eyebrow font-semibold uppercase text-primary">Capabilities</p>
            <div className="mt-2 space-y-3">
              {(
                [
                  ["booking", "Booking", "Let the receptionist create, move and cancel appointments."],
                  ["knowledge_qa", "Knowledge Q&A", "Answer clinic questions from the knowledge base."],
                  ["callback_requests", "Callback requests", "Take callback requests when a caller prefers a human."],
                ] as const
              ).map(([key, title, description]) => (
                <FormField
                  key={key}
                  control={form.control}
                  name={`capabilities.${key}`}
                  render={({ field }) => (
                    <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{title}</p>
                        <p className="text-xs text-muted-foreground">{description}</p>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          aria-label={title}
                        />
                      </FormControl>
                    </div>
                  )}
                />
              ))}
            </div>
          </div>

          <Separator />

          {/* Escalation */}
          <div>
            <p className="text-eyebrow font-semibold uppercase text-primary">Escalation</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Used when a caller needs a human or an emergency is detected.
            </p>
            <div className="mt-3 space-y-4">
              <FormField
                control={form.control}
                name="escalation.transfer_message"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Transfer message</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder="What the receptionist says before handing over to staff."
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="escalation.callback_number"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Callback number</FormLabel>
                      <FormControl>
                        <Input type="tel" inputMode="tel" placeholder="+92 300 1234567" {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="escalation.emergency_guidance"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Emergency guidance</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. For emergencies call 1122 immediately."
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" className="min-h-11" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {isEdit ? "Save changes" : "Create receptionist"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
