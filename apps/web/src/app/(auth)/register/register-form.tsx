"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { GlassCard } from "@/components/glass/glass-card";
import { useAuthStore } from "@/stores/auth-store";

// Mirrors the backend rules exactly (services/ai-backend):
//   password length ≥ 10, must contain letters AND numbers (validate_password_strength).
const registerSchema = z.object({
  organizationName: z
    .string()
    .min(2, "Organization name must be at least 2 characters")
    .max(160, "Organization name is too long"),
  adminName: z
    .string()
    .min(1, "Your name is required")
    .max(120, "Name is too long"),
  email: z.email("Enter a valid email address"),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .refine(
      (value) => /[A-Za-z]/.test(value) && /\d/.test(value),
      "Password must contain both letters and numbers"
    ),
});

type RegisterValues = z.infer<typeof registerSchema>;

export function RegisterForm() {
  const router = useRouter();
  const register = useAuthStore((s) => s.register);

  const [formError, setFormError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { organizationName: "", adminName: "", email: "", password: "" },
  });

  async function onSubmit(values: RegisterValues) {
    setFormError(null);
    const result = await register({
      organizationName: values.organizationName.trim(),
      adminName: values.adminName.trim(),
      email: values.email.trim(),
      password: values.password,
    });

    if (result.ok) {
      toast.success("Workspace created. Welcome to VITALORA.");
      router.push("/overview");
      return;
    }

    if (result.field === "organizationName") {
      form.setError("organizationName", { message: result.message });
    } else {
      setFormError(result.message);
      toast.error(result.message);
    }
  }

  const submitting = form.formState.isSubmitting;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Create your clinic workspace
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          You&apos;ll be the organization owner — add clinics, staff and AI
          receptionists right after.
        </p>
      </div>

      <GlassCard variant="strong" className="p-6 sm:p-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            {formError ? (
              <Alert variant="destructive" role="alert">
                <AlertCircle className="size-4" aria-hidden="true" />
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            <FormField
              control={form.control}
              name="organizationName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Organization name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Sunrise Medical Group"
                      autoComplete="organization"
                      className="min-h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Becomes your workspace ID, e.g. sunrise-medical-group.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="adminName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Your name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Dr. Ayesha Khan"
                      autoComplete="name"
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
                        autoComplete="new-password"
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
                  <FormDescription>
                    At least 10 characters, with both letters and numbers.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button
              type="submit"
              className="min-h-11 w-full rounded-full shadow-[var(--shadow-glow-value)]"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Creating workspace…
                </>
              ) : (
                "Create workspace"
              )}
            </Button>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Creates a trial workspace with you as its owner. No payment
              details are required at this step.
            </p>
          </form>
        </Form>
      </GlassCard>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
