"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { GlassCard } from "@/components/glass/glass-card";
import { useAuthStore, type OrgChoice } from "@/stores/auth-store";

const loginSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  orgSlug: z.string().max(80, "Keep the organization ID under 80 characters").optional(),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useAuthStore((s) => s.login);

  // `next` must be a local path — avoid open redirects.
  const rawNext = searchParams.get("next");
  const nextPath =
    rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//")
      ? rawNext
      : "/dashboard";

  const [formError, setFormError] = React.useState<string | null>(null);
  const [orgChoices, setOrgChoices] = React.useState<OrgChoice[] | null>(null);
  const [selectedOrg, setSelectedOrg] = React.useState<string>("");
  const [showOrgField, setShowOrgField] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", orgSlug: "" },
  });

  async function onSubmit(values: LoginValues) {
    setFormError(null);
    const result = await login(
      values.email.trim(),
      values.password,
      values.orgSlug?.trim() || undefined
    );

    if (result.ok) {
      toast.success("Signed in. Welcome back.");
      router.push(nextPath);
      return;
    }

    if (result.orgChoices && result.orgChoices.length > 0) {
      setOrgChoices(result.orgChoices);
      setSelectedOrg(result.orgChoices[0]?.slug ?? "");
      setFormError(result.message);
      return;
    }

    setFormError(result.message);
    toast.error(result.message);
  }

  function continueWithOrg() {
    if (!selectedOrg) return;
    form.setValue("orgSlug", selectedOrg, { shouldValidate: true });
    void form.handleSubmit(onSubmit)();
  }

  const submitting = form.formState.isSubmitting;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Sign in to VITALORA
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Your clinic&apos;s AI receptionist console.
        </p>
      </div>

      <GlassCard variant="strong" className="p-6 sm:p-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            {formError && !orgChoices ? (
              <Alert variant="destructive" role="alert">
                <AlertCircle className="size-4" aria-hidden="true" />
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Work email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@clinic.com"
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
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        className="min-h-11 pr-11"
                        {...field}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground"
                      >
                        {showPassword ? (
                          <EyeOff className="size-4" aria-hidden="true" />
                        ) : (
                          <Eye className="size-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {orgChoices && orgChoices.length > 0 ? (
              <fieldset className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                <legend className="px-1 text-sm font-medium text-foreground">
                  Choose your organization
                </legend>
                <RadioGroup
                  value={selectedOrg}
                  onValueChange={setSelectedOrg}
                  aria-label="Organization"
                >
                  {orgChoices.map((org) => (
                    <label
                      key={org.slug}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/10"
                    >
                      <RadioGroupItem value={org.slug} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">
                          {org.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          ID: {org.slug}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <Button
                  type="button"
                  className="min-h-11 w-full"
                  onClick={continueWithOrg}
                  disabled={!selectedOrg || submitting}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Signing in…
                    </>
                  ) : (
                    "Continue"
                  )}
                </Button>
              </fieldset>
            ) : (
              <>
                {showOrgField ? (
                  <FormField
                    control={form.control}
                    name="orgSlug"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Organization ID</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="e.g. sunrise-clinic"
                            autoComplete="organization"
                            className="min-h-11"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Only needed when your email is linked to more than one
                          organization.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowOrgField(true)}
                    className="text-left text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Signing in to a specific organization?
                  </button>
                )}

                <Button
                  type="submit"
                  className="min-h-11 w-full rounded-full shadow-[var(--shadow-glow-value)]"
                  disabled={submitting}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Signing in…
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </>
            )}
          </form>
        </Form>
      </GlassCard>

      <p className="text-center text-sm text-muted-foreground">
        New to VITALORA?{" "}
        <Link
          href="/register"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Create your clinic workspace
        </Link>
      </p>
    </div>
  );
}
