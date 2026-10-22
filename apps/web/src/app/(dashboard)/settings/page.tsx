"use client";

import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/glass/page-header";
import { ProfileSettings } from "@/components/ops/settings/profile-settings";
import { ClinicsSettings } from "@/components/ops/settings/clinics-settings";
import { StaffServicesSettings } from "@/components/ops/settings/staff-services-settings";
import { SecurityAuditSettings } from "@/components/ops/settings/security-audit-settings";

/**
 * Organization settings — tabbed: Profile, Clinics & Hours, Staff & Services,
 * Security & Audit. Each tab loads its own data lazily (components mount on
 * first visit) so the page stays honest about what is actually fetched.
 */
export default function SettingsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Settings"
        description="Your organization profile, clinics and opening hours, staff and services, plus the security and audit record."
      />

      <Tabs defaultValue="profile" className="w-full">
        <TabsList
          aria-label="Settings sections"
          className="h-auto w-full flex-wrap justify-start gap-1 sm:w-fit"
        >
          <TabsTrigger value="profile" className="min-h-11 px-4 sm:min-h-9">
            Profile
          </TabsTrigger>
          <TabsTrigger value="clinics" className="min-h-11 px-4 sm:min-h-9">
            Clinics &amp; Hours
          </TabsTrigger>
          <TabsTrigger value="staff" className="min-h-11 px-4 sm:min-h-9">
            Staff &amp; Services
          </TabsTrigger>
          <TabsTrigger value="security" className="min-h-11 px-4 sm:min-h-9">
            Security &amp; Audit
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-6">
          <ProfileSettings />
        </TabsContent>
        <TabsContent value="clinics" className="mt-6">
          <ClinicsSettings />
        </TabsContent>
        <TabsContent value="staff" className="mt-6">
          <StaffServicesSettings />
        </TabsContent>
        <TabsContent value="security" className="mt-6">
          <SecurityAuditSettings />
        </TabsContent>
      </Tabs>
    </>
  );
}
