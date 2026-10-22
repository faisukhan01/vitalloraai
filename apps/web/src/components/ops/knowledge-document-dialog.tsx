"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { api } from "@vitalora/api-client";
import type { KnowledgeDocument } from "@vitalora/shared-types";

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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { mapApiError } from "@/lib/utils-api";

/** Mirrors the backend schema: title 2–200, content_text ≤ 200k. */
const knowledgeDocSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Title must be at least 2 characters")
    .max(200, "Keep the title under 200 characters"),
  source_type: z.enum(["manual", "faq", "document", "url"]),
  content: z
    .string()
    .min(20, "Content must be at least 20 characters — the receptionist answers from this text")
    .max(200_000, "Content is too long (max 200,000 characters)"),
  clinicId: z.string().optional(),
});

type KnowledgeDocValues = z.infer<typeof knowledgeDocSchema>;

const SOURCE_TYPE_LABELS: Record<KnowledgeDocValues["source_type"], string> = {
  manual: "Manual (written content)",
  faq: "FAQ (question & answer)",
  document: "Document (policy or leaflet)",
  url: "URL (web page content)",
};

export interface KnowledgeDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When present the dialog edits this document; otherwise it creates one. */
  document?: KnowledgeDocument | null;
  onSaved: (saved: KnowledgeDocument, mode: "create" | "edit") => void;
}

/**
 * Create / edit dialog for knowledge documents. Edit mode intentionally
 * exposes only title + content (the fields the receptionist consumes);
 * lifecycle status is managed through the row actions.
 */
export function KnowledgeDocumentDialog({
  open,
  onOpenChange,
  document,
  onSaved,
}: KnowledgeDocumentDialogProps) {
  const isEdit = Boolean(document);

  const clinicsQuery = useQuery({
    queryKey: ["clinics"],
    queryFn: () => api.listClinics(),
    enabled: open,
  });

  const form = useForm<KnowledgeDocValues>({
    resolver: zodResolver(knowledgeDocSchema),
    defaultValues: {
      title: "",
      source_type: "manual",
      content: "",
      clinicId: "none",
    },
  });

  // Re-seed the form whenever the dialog opens for a different target.
  React.useEffect(() => {
    if (!open) return;
    if (document) {
      form.reset({
        title: document.title,
        source_type: document.source_type,
        content: document.content_text,
        clinicId: document.clinic_id ?? "none",
      });
    } else {
      form.reset({ title: "", source_type: "manual", content: "", clinicId: "none" });
    }
  }, [open, document, form]);

  const [submitError, setSubmitError] = React.useState<string | null>(null);

  async function onSubmit(values: KnowledgeDocValues) {
    setSubmitError(null);
    const clinicId = values.clinicId && values.clinicId !== "none" ? values.clinicId : undefined;
    try {
      if (document) {
        const updated = await api.updateKnowledgeDocument(document.id, {
          title: values.title,
          content_text: values.content,
        });
        onSaved(updated, "edit");
      } else {
        const created = await api.createKnowledgeDocument({
          title: values.title,
          source_type: values.source_type,
          content_text: values.content,
          clinic_id: clinicId,
        });
        onSaved(created, "create");
      }
      onOpenChange(false);
    } catch (err) {
      setSubmitError(mapApiError(err));
    }
  }

  const contentValue = form.watch("content");
  const contentLength = contentValue?.length ?? 0;
  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle>
            {isEdit ? "Edit knowledge document" : "Add knowledge"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Changes re-chunk and re-index the document immediately."
              : "Add approved content the AI receptionist may use to answer callers."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
            noValidate
          >
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Booking & cancellation policy"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {!isEdit ? (
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="source_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Source type</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="min-h-11 w-full">
                            <SelectValue placeholder="Choose a source type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(Object.keys(SOURCE_TYPE_LABELS) as KnowledgeDocValues["source_type"][]).map(
                            (t) => (
                              <SelectItem key={t} value={t}>
                                {SOURCE_TYPE_LABELS[t]}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="clinicId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Clinic <span className="text-muted-foreground">(optional)</span>
                      </FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="min-h-11 w-full">
                            <SelectValue placeholder="All clinics" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">All clinics</SelectItem>
                          {clinicsQuery.data?.items.map((clinic) => (
                            <SelectItem key={clinic.id} value={clinic.id}>
                              {clinic.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Scope this content to one clinic&apos;s receptionist.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ) : null}

            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem className="flex min-h-0 flex-1 flex-col">
                  <div className="flex items-baseline justify-between">
                    <FormLabel>Content</FormLabel>
                    <span
                      aria-live="polite"
                      className={
                        contentLength < 20
                          ? "text-xs tabular-nums text-warning"
                          : "text-xs tabular-nums text-muted-foreground"
                      }
                    >
                      {contentLength.toLocaleString()} characters
                      {contentLength < 20 ? " · minimum 20" : ""}
                    </span>
                  </div>
                  <FormControl>
                    <Textarea
                      placeholder="Write or paste the approved information the receptionist should answer from…"
                      className="min-h-44 flex-1 resize-y font-[15px] leading-relaxed sm:min-h-56"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    The text is split into ~800-character chunks and indexed for
                    retrieval. Only this approved content is used.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {submitError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {submitError}
              </p>
            ) : null}

            <DialogFooter className="gap-2 border-t border-border/60 pt-4">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11 shadow-[var(--shadow-glow-value)]"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {isEdit ? "Saving…" : "Creating…"}
                  </>
                ) : isEdit ? (
                  "Save changes"
                ) : (
                  "Create document"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
