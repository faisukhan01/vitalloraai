"use client";

import { create } from "zustand";
import { ApiError, api } from "@vitalora/api-client";
import type { Organization, User } from "@vitalora/shared-types";

import { mapApiError } from "@/lib/utils-api";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface OrgChoice {
  slug: string;
  name: string;
}

export type AuthErrorField = "organizationName" | "email" | "password" | "root";

export type AuthActionResult =
  | { ok: true }
  | {
      ok: false;
      /** Human-friendly message for inline alert / toast. */
      message: string;
      /** Present on login 409 — the email exists in multiple organizations. */
      orgChoices?: OrgChoice[];
      /** Present when the failure maps to a specific field. */
      field?: AuthErrorField;
    };

interface RegisterPayload {
  organizationName: string;
  adminName: string;
  email: string;
  password: string;
}

interface AuthState {
  user: User | null;
  organization: Organization | null;
  permissions: string[];
  status: AuthStatus;

  /** Restore the session from the refresh cookie (call once on mount). */
  bootstrap: () => Promise<void>;
  login: (email: string, password: string, orgSlug?: string) => Promise<AuthActionResult>;
  register: (payload: RegisterPayload) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  /** Reload the profile (e.g. after role/organization changes). */
  refreshProfile: () => Promise<void>;
}

// Module-level guard: bootstrap must never run twice concurrently
// (React StrictMode double-invokes effects in development).
let bootstrapPromise: Promise<void> | null = null;

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  organization: null,
  permissions: [],
  status: "loading",

  bootstrap: async () => {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      try {
        const me = await api.bootstrapSession();
        if (me) {
          set({
            user: me.user,
            organization: me.organization,
            permissions: me.permissions,
            status: "authenticated",
          });
        } else {
          api.setToken(null);
          set({ user: null, organization: null, permissions: [], status: "anonymous" });
        }
      } catch {
        api.setToken(null);
        set({ user: null, organization: null, permissions: [], status: "anonymous" });
      } finally {
        bootstrapPromise = null;
      }
    })();
    return bootstrapPromise;
  },

  login: async (email, password, orgSlug) => {
    try {
      await api.login(email, password, orgSlug);
      const me = await api.me();
      set({
        user: me.user,
        organization: me.organization,
        permissions: me.permissions,
        status: "authenticated",
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const raw = err.details?.organizations;
        const orgChoices: OrgChoice[] = Array.isArray(raw)
          ? raw
              .map((o) => {
                if (o && typeof o === "object" && "slug" in o && "name" in o) {
                  return { slug: String(o.slug), name: String(o.name) };
                }
                return null;
              })
              .filter((o): o is OrgChoice => o !== null)
          : [];
        if (orgChoices.length > 0) {
          return {
            ok: false,
            message: mapApiError(err),
            orgChoices,
          };
        }
      }
      return { ok: false, message: mapApiError(err) };
    }
  },

  register: async ({ organizationName, adminName, email, password }) => {
    try {
      await api.registerOrganization({
        organization: { name: organizationName },
        admin: { name: adminName, email, password },
      });
      const me = await api.me();
      set({
        user: me.user,
        organization: me.organization,
        permissions: me.permissions,
        status: "authenticated",
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        // Duplicate organization identifier → surface on the org-name field.
        const message = mapApiError(err);
        const field: AuthErrorField =
          err.status === 409 && /organization/i.test(err.message)
            ? "organizationName"
            : "root";
        return { ok: false, message, field };
      }
      return { ok: false, message: mapApiError(err) };
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      // Even if the network call fails, clear the local session.
    } finally {
      api.setToken(null);
      set({ user: null, organization: null, permissions: [], status: "anonymous" });
    }
  },

  refreshProfile: async () => {
    try {
      const me = await api.me();
      set({
        user: me.user,
        organization: me.organization,
        permissions: me.permissions,
        status: "authenticated",
      });
    } catch {
      api.setToken(null);
      set({ user: null, organization: null, permissions: [], status: "anonymous" });
    }
  },
}));

/** Convenience selector — whether the current user holds a permission. */
export function selectHasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(permission);
}
