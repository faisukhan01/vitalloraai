import { SiteFooter } from "@/components/landing/site-footer";
import { SiteNavbar } from "@/components/landing/site-navbar";
import { Features } from "@/components/landing/features";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Pricing } from "@/components/landing/pricing";
import { Security } from "@/components/landing/security";

/**
 * VITALORA AI — marketing landing page (/).
 * The root layout provides `min-h-screen flex flex-col` on <body>; the
 * flex-1 main plus the footer's mt-auto create the sticky-footer pattern.
 */
export default function LandingPage() {
  return (
    <>
      <SiteNavbar />
      <main id="main-content" className="flex-1">
        <Hero />
        <Features />
        <HowItWorks />
        <Security />
        <Pricing />
      </main>
      <SiteFooter />
    </>
  );
}
