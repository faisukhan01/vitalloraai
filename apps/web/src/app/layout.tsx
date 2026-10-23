import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "VITALORA AI — Healthcare AI Receptionist Platform",
  description:
    "Multilingual AI voice receptionist for clinics. Answers every call in the patient's language, books appointments with conflict prevention, and grounds every answer in your clinic's own knowledge base.",
  applicationName: "VITALORA AI",
  keywords: [
    "healthcare AI receptionist",
    "multilingual voice AI",
    "clinic appointment booking",
    "medical practice automation",
  ],
  icons: {
    icon: "/vitalora-icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0a09" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <body
        className={`${inter.variable} min-h-screen flex flex-col bg-background font-sans text-foreground antialiased`}
      >
        <ThemeProvider>
          {children}
          <Toaster position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
