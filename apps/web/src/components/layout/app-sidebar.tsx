"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot,
  Building2,
  CalendarDays,
  LayoutDashboard,
  Library,
  LogOut,
  Mic,
  PhoneCall,
} from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { initials } from "@/lib/utils-api";
import { useAuthStore } from "@/stores/auth-store";

const NAV_ITEMS = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "AI Receptionists", url: "/receptionists", icon: Bot },
  { title: "Appointments", url: "/appointments", icon: CalendarDays },
  { title: "Voice Lab", url: "/voice-lab", icon: Mic },
  { title: "Knowledge Base", url: "/knowledge", icon: Library },
  { title: "Call History", url: "/calls", icon: PhoneCall },
  { title: "Organization", url: "/settings", icon: Building2 },
] as const;

/**
 * AppSidebar — glass navigation rail for the authenticated workspace.
 * Collapses to icons on desktop (rail trigger at the edge), becomes a Sheet
 * on mobile (handled by the sidebar primitive + MobileTopbar trigger).
 */
export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);
  const logout = useAuthStore((s) => s.logout);

  const isActive = (url: string) =>
    pathname === url || pathname.startsWith(`${url}/`);

  async function handleLogout() {
    await logout();
    router.push("/");
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Vitalora AI">
              <Link href="/dashboard" aria-label="Vitalora AI — go to dashboard">
                <BrandMark size="sm" />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {organization ? (
            <div className="truncate px-2 pt-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              {organization.name}
              {organization.plan === "demo" || organization.plan === "trial" ? (
                <span className="ml-1.5 rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                  {organization.plan}
                </span>
              ) : null}
            </div>
          ) : null}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    tooltip={item.title}
                  >
                    <Link href={item.url}>
                      <item.icon aria-hidden="true" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  aria-label="Open account menu"
                  className="data-[state=open]:bg-sidebar-accent"
                >
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-brand-soft text-xs font-medium text-primary">
                      {initials(user?.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">
                      {user?.name ?? "Account"}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user?.role ?? ""}
                    </span>
                  </span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="flex flex-col">
                  <span className="truncate">{user?.name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {user?.email}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Building2 aria-hidden="true" />
                    Organization settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => void handleLogout()}
                >
                  <LogOut aria-hidden="true" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem className="flex items-center justify-between px-2 py-1 group-data-[collapsible=icon]:hidden">
            <span className="text-xs text-muted-foreground">Theme</span>
            <ThemeToggle />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
