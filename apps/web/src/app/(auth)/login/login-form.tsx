"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  Sparkles,
} from "lucide-react";

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
import { useAuthStore, type OrgChoice } from "@/stores/auth-store";

const loginSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  orgSlug: z.string().max(80, "Keep the organization ID under 80 characters").optional(),
});

type LoginValues = z.infer<typeof loginSchema>;

const DEMO_EMAIL = "admin@demo.vitalora.ai";
const DEMO_PASSWORD = "Vitalora#Demo2024";

const easeOut = [0.21, 0.47, 0.32, 0.98] as const;

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useAuthStore((s) => s.login);
  const reduceMotion = useReducedMotion();

  // `next` must be a local path — avoid open redirects.
  const rawNext = searchParams.get("next");
  const nextPath =
    rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//")
      ? rawNext
      : "/overview";

  const [formError, setFormError] = React.useState<string | null>(null);
  const [orgChoices, setOrgChoices] = React.useState<OrgChoice[] | null>(null);
  const [selectedOrg, setSelectedOrg] = React.useState<string>("");
  const [showOrgField, setShowOrgField] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [demoFilled, setDemoFilled] = React.useState(false);

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

  function fillDemo() {
    form.setValue("email", DEMO_EMAIL, { shouldValidate: true });
    form.setValue("password", DEMO_PASSWORD, { shouldValidate: true });
    setDemoFilled(true);
    toast.success("Demo credentials filled — press Sign in.");
  }

  const submitting = form.formState.isSubmitting;
  const motionProps = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 14 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.5, ease: easeOut },
      };

  return (
    <motion.div
      className="space-y-6"
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: easeOut }}
    >
      <div className="space-y-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
          Vitalora Console
        </p>
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
          Welcome back
        </h1>
        <p className="text-sm text-muted-foreground">
          Sign in to your clinic&apos;s AI front desk.
        </p>
      </div>

      {/* Demo quick-fill — honest, labeled demo data */}
      <button
        type="button"
        onClick={fillDemo}
        aria-label="Fill demo clinic credentials"
        className="group flex w-full items-center gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-3 text-left transition-colors hover:border-primary/45 hover:bg-primary/10"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary transition-transform group-hover:scale-105"
        >
          <Sparkles className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            Exploring? Use the demo clinic
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {demoFilled ? "Credentials filled ✓" : DEMO_EMAIL} · one click
          </span>
        </span>
        <ArrowRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </button>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {formError && !orgChoices ? (
            <motion.div {...motionProps}>
              <Alert variant="destructive" role="alert">
                <AlertCircle className="size-4" aria-hidden="true" />
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            </motion.div>
          ) : null}

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Work email</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Mail
                      className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@clinic.com"
                      className="h-12 rounded-xl pl-11"
                      {...field}
                    />
                  </div>
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
                      placeholder="••••••••"
                      className="h-12 rounded-xl pr-12"
                      {...field}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-muted-foreground transition-colors hover:text-foreground"
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
            <motion.fieldset
              {...motionProps}
              className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
            >
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
                className="h-11 w-full"
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
            </motion.fieldset>
          ) : (
            <motion.div
              className="space-y-4"
              {...(reduceMotion
                ? {}
                : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.3 } })}
            >
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
                          className="h-12 rounded-xl"
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
                disabled={submitting}
                className="h-12 w-full rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 text-[0.95rem] font-semibold text-white shadow-[var(--shadow-glow-value)] transition-all hover:from-teal-500 hover:to-emerald-500 hover:shadow-lg"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </>
                )}
              </Button>
            </motion.div>
          )}
        </form>
      </Form>

      <p className="text-center text-sm text-muted-foreground">
        New to VITALORA?{" "}
        <Link
          href="/register"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Create your clinic workspace
        </Link>
      </p>
    </motion.div>
  );
}
