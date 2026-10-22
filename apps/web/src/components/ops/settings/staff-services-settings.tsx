"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, type Control, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Plus, Stethoscope, Tag } from "lucide-react";
import { toast } from "sonner";

import { api } from "@vitalora/api-client";
import type { Provider, Service } from "@vitalora/shared-types";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GlassPanel } from "@/components/glass/glass-panel";
import { EmptyState } from "@/components/glass/empty-state";
import { StatusBadge } from "@/components/glass/status-badge";
import { SkeletonGlass, SkeletonGlassLine } from "@/components/glass/skeleton-glass";
import { ErrorState } from "@/components/ops/error-state";
import { truncate } from "@/components/ops/helpers";
import { mapApiError } from "@/lib/utils-api";
import { useAuthStore } from "@/stores/auth-store";

const DURATIONS = [15, 30, 45, 60] as const;

const providerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(120, "Keep the name under 120 characters"),
  specialty: z.string().trim().max(120).optional(),
  email: z
    .string()
    .trim()
    .max(160)
    .refine((v) => v === "" || z.string().email().safeParse(v).success, {
      message: "Enter a valid email address",
    })
    .optional(),
  phone: z.string().trim().max(40).optional(),
  clinicId: z.string().min(1, "Choose the clinic this provider works at"),
});

type ProviderValues = z.infer<typeof providerSchema>;

const serviceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(160, "Keep the name under 160 characters"),
  description: z.string().trim().max(2000).optional(),
  durationMinutes: z.enum(["15", "30", "45", "60"]),
  priceDisplay: z.string().trim().max(60).optional(),
  clinicId: z.string().min(1, "Choose the clinic offering this service"),
});

type ServiceValues = z.infer<typeof serviceSchema>;

/**
 * StaffServicesSettings — providers (clinical staff) and bookable services,
 * each as an inline table with an honest create dialog. Providers use
 * staff:write permissions; services use clinics:write (backend matrix).
 */
export function StaffServicesSettings() {
  const permissions = useAuthStore((s) => s.permissions);
  const canWriteStaff = permissions.includes("staff:write");
  const canWriteServices = permissions.includes("clinics:write");

  const [providerOpen, setProviderOpen] = React.useState(false);
  const [serviceOpen, setServiceOpen] = React.useState(false);

  return (
    <div className="space-y-6">
      <ProvidersSection
        canWrite={canWriteStaff}
        onCreateClick={() => setProviderOpen(true)}
      />
      <ServicesSection
        canWrite={canWriteServices}
        onCreateClick={() => setServiceOpen(true)}
      />
      <CreateProviderDialog open={providerOpen} onOpenChange={setProviderOpen} />
      <CreateServiceDialog open={serviceOpen} onOpenChange={setServiceOpen} />
    </div>
  );
}

function ProvidersSection({
  canWrite,
  onCreateClick,
}: {
  canWrite: boolean;
  onCreateClick: () => void;
}) {
  const listQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.listProviders(),
  });

  const items = listQuery.data?.items ?? [];

  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold tracking-tight text-foreground">Staff</h2>
          <p className="text-sm text-muted-foreground">
            Providers (doctors, dentists, technicians) whose calendars the AI
            receptionist books against.
          </p>
        </div>
        {canWrite ? (
          <Button
            className="min-h-11 shadow-[var(--shadow-glow-value)]"
            onClick={onCreateClick}
          >
            <Plus className="size-4" aria-hidden="true" />
            Add provider
          </Button>
        ) : null}
      </div>

      <div className="mt-5">
        {listQuery.isLoading ? (
          <div aria-hidden="true" className="space-y-2">
            <SkeletonGlass className="h-12 w-full" />
            <SkeletonGlass className="h-12 w-full" />
          </div>
        ) : listQuery.isError ? (
          <ErrorState
            context="providers"
            message={mapApiError(listQuery.error)}
            onRetry={() => listQuery.refetch()}
            retrying={listQuery.isFetching}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Stethoscope}
            title="No providers yet"
            description="Add your clinical staff so their working hours and appointments can be managed."
            action={
              canWrite ? (
                <Button className="min-h-11" onClick={onCreateClick}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add provider
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Specialty</TableHead>
                  <TableHead>Clinic</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((p: Provider) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-foreground">
                      {p.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.specialty ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.clinic_name ?? p.clinic_id}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.email ?? p.phone ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </GlassPanel>
  );
}

function ServicesSection({
  canWrite,
  onCreateClick,
}: {
  canWrite: boolean;
  onCreateClick: () => void;
}) {
  const listQuery = useQuery({
    queryKey: ["services"],
    queryFn: () => api.listServices(),
  });

  const items = listQuery.data?.items ?? [];

  return (
    <GlassPanel className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold tracking-tight text-foreground">Services</h2>
          <p className="text-sm text-muted-foreground">
            Bookable services with durations used to compute appointment slots.
          </p>
        </div>
        {canWrite ? (
          <Button
            className="min-h-11 shadow-[var(--shadow-glow-value)]"
            onClick={onCreateClick}
          >
            <Plus className="size-4" aria-hidden="true" />
            Add service
          </Button>
        ) : null}
      </div>

      <div className="mt-5">
        {listQuery.isLoading ? (
          <div aria-hidden="true" className="space-y-2">
            <SkeletonGlass className="h-12 w-full" />
            <SkeletonGlass className="h-12 w-full" />
          </div>
        ) : listQuery.isError ? (
          <ErrorState
            context="services"
            message={mapApiError(listQuery.error)}
            onRetry={() => listQuery.refetch()}
            retrying={listQuery.isFetching}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Tag}
            title="No services yet"
            description="Create the services patients can book — each one's duration defines the appointment slot length."
            action={
              canWrite ? (
                <Button className="min-h-11" onClick={onCreateClick}>
                  <Plus className="size-4" aria-hidden="true" />
                  Add service
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Clinic</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s: Service) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium text-foreground">
                      {s.name}
                    </TableCell>
                    <TableCell className="max-w-56 text-muted-foreground">
                      {s.description ? truncate(s.description, 60) : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {s.duration_minutes} min
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.price_display ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.clinic_name ?? s.clinic_id}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={s.is_active ? "indexed" : "inactive"}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </GlassPanel>
  );
}

function ClinicSelectField<T extends { clinicId: string }>({
  control,
  name,
  label,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
}) {
  const clinicsQuery = useQuery({
    queryKey: ["clinics"],
    queryFn: () => api.listClinics(),
  });

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger className="min-h-11 w-full">
                <SelectValue
                  placeholder={
                    clinicsQuery.isLoading ? "Loading clinics…" : "Choose a clinic"
                  }
                />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {(clinicsQuery.data?.items ?? []).map((clinic) => (
                <SelectItem key={clinic.id} value={clinic.id}>
                  {clinic.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {clinicsQuery.isError ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t load clinics: {mapApiError(clinicsQuery.error)}
            </p>
          ) : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function CreateProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const form = useForm<ProviderValues>({
    resolver: zodResolver(providerSchema),
    defaultValues: { name: "", specialty: "", email: "", phone: "", clinicId: "" },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({ name: "", specialty: "", email: "", phone: "", clinicId: "" });
      setSubmitError(null);
    }
  }, [open, form]);

  async function onSubmit(values: ProviderValues) {
    setSubmitError(null);
    try {
      const provider = await api.createProvider({
        name: values.name,
        clinic_id: values.clinicId,
        specialty: values.specialty || null,
        email: values.email || null,
        phone: values.phone || null,
      });
      toast.success(`Provider “${provider.name}” added.`);
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(mapApiError(err));
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>
            A clinical staff member whose schedule the AI receptionist can book.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Dr. Ayesha Khan"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="specialty"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Specialty <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Orthodontics"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Email <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="dr@clinic.com"
                        className="min-h-11"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Phone <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="tel"
                        placeholder="+92 300 0000000"
                        className="min-h-11"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <ClinicSelectField control={form.control} name="clinicId" label="Clinic" />

            {submitError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {submitError}
              </p>
            ) : null}

            <DialogFooter className="gap-2">
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
                    Adding…
                  </>
                ) : (
                  "Add provider"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function CreateServiceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const form = useForm<ServiceValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: "",
      description: "",
      durationMinutes: "30",
      priceDisplay: "",
      clinicId: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        name: "",
        description: "",
        durationMinutes: "30",
        priceDisplay: "",
        clinicId: "",
      });
      setSubmitError(null);
    }
  }, [open, form]);

  async function onSubmit(values: ServiceValues) {
    setSubmitError(null);
    try {
      const service = await api.createService({
        name: values.name,
        clinic_id: values.clinicId,
        description: values.description || null,
        duration_minutes: Number(values.durationMinutes),
        price_display: values.priceDisplay || null,
      });
      toast.success(`Service “${service.name}” created.`);
      void queryClient.invalidateQueries({ queryKey: ["services"] });
      onOpenChange(false);
    } catch (err) {
      setSubmitError(mapApiError(err));
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add service</DialogTitle>
          <DialogDescription>
            A bookable service. Its duration defines the slot length offered to
            callers.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Teeth cleaning"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Description <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Short description shown in bookings"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="durationMinutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Duration</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="min-h-11 w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DURATIONS.map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            {d} minutes
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Slot length used by the availability engine.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="priceDisplay"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Price <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. from PKR 3,000"
                        className="min-h-11"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <ClinicSelectField control={form.control} name="clinicId" label="Clinic" />

            {submitError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {submitError}
              </p>
            ) : null}

            <DialogFooter className="gap-2">
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
                    Creating…
                  </>
                ) : (
                  "Create service"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
