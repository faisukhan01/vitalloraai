"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Building2, KeyRound, Loader2, ShieldCheck, UserRound } from "lucide-react";

import { api } from "@vitalora/api-client";

import { Button } from "@/components/ui/button";
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
import { GlassCard } from "@/components/glass/glass-card";
import { GlassPanel } from "@/components/glass/glass-panel";
import { StatusBadge } from "@/components/glass/status-badge";
import { mapApiError } from "@/lib/utils-api";
import { useAuthStore } from "@/stores/auth-store";

/** Mirrors the backend rule: ≥10 chars with both letters and numbers. */
const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z
    .string()
    .min(10, "Password must be at least 10 characters long")
    .regex(
      /^(?=.*[A-Za-z])(?=.*\d)/,
      "Password must contain both letters and numbers"
    ),
});

type PasswordValues = z.infer<typeof passwordSchema>;

function ProfileRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}

/**
 * ProfileSettings — organization identity, the signed-in user's profile and
 * the change-password form. After a successful change the backend has
 * invalidated the access token, so the user is logged out immediately.
 */
export function ProfileSettings() {
  const user = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);
  const logout = useAuthStore((s) => s.logout);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "" },
  });

  async function onSubmit(values: PasswordValues) {
    setSubmitError(null);
    try {
      await api.changePassword(values.currentPassword, values.newPassword);
      toast.success(
        "Password changed. You've been signed out everywhere — please sign in again."
      );
      await logout();
    } catch (err) {
      setSubmitError(mapApiError(err));
      toast.error(mapApiError(err));
    }
  }

  if (!user || !organization) {
    return (
      <GlassPanel className="px-6 py-10 text-center text-sm text-muted-foreground">
        Profile is unavailable — your session could not be loaded. Please sign in
        again.
      </GlassPanel>
    );
  }

  const submitting = form.formState.isSubmitting;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Organization */}
        <GlassCard className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-primary"
            >
              <Building2 className="size-5" />
            </span>
            <div>
              <h2 className="font-semibold tracking-tight text-foreground">
                Organization
              </h2>
              <p className="text-sm text-muted-foreground">
                Workspace identity shown across the console.
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ProfileRow label="Name" value={organization.name} />
            <ProfileRow
              label="Slug (read-only)"
              value={<span className="font-mono">{organization.slug}</span>}
            />
            <ProfileRow
              label="Plan"
              value={<StatusBadge status={organization.plan} />}
            />
            <ProfileRow
              label="Status"
              value={<StatusBadge status={organization.status} />}
            />
          </dl>
        </GlassCard>

        {/* Current user */}
        <GlassCard className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-primary"
            >
              <UserRound className="size-5" />
            </span>
            <div>
              <h2 className="font-semibold tracking-tight text-foreground">
                Your profile
              </h2>
              <p className="text-sm text-muted-foreground">
                Signed-in account and role in this organization.
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ProfileRow label="Name" value={user.name} />
            <ProfileRow label="Email" value={user.email} />
            <ProfileRow
              label="Role"
              value={
                <span className="capitalize">
                  {user.role.replace(/_/g, " ")}
                </span>
              }
            />
            <ProfileRow
              label="Email verified"
              value={
                user.email_verified ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
                    Verified
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Not verified — email flows are not configured yet
                  </span>
                )
              }
            />
          </dl>
        </GlassCard>
      </div>

      {/* Change password */}
      <GlassPanel className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-primary"
          >
            <KeyRound className="size-5" />
          </span>
          <div>
            <h2 className="font-semibold tracking-tight text-foreground">
              Change password
            </h2>
            <p className="text-sm text-muted-foreground">
              Changing your password signs the account out on every device for
              security.
            </p>
          </div>
        </div>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="mt-5 max-w-md space-y-5"
            noValidate
          >
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Current password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
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
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    At least 10 characters, with both letters and numbers.
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

            <Button
              type="submit"
              className="min-h-11 shadow-[var(--shadow-glow-value)]"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Updating…
                </>
              ) : (
                <>
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  Update password
                </>
              )}
            </Button>
          </form>
        </Form>
      </GlassPanel>
    </div>
  );
}
