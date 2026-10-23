"""Role-based access control.

Permission model (least privilege, spec §10):
  owner         - full control of the organization
  org_admin     - manage clinics, staff, receptionists, appointments, knowledge
  clinic_admin  - manage own clinic resources and view its data
  staff         - manage appointments and view operational data
  analyst       - read-only analytics and call history

Permission strings: "<resource>:<action>" where action in {read, write, admin}.
"""

from __future__ import annotations

ROLES = ("owner", "org_admin", "clinic_admin", "staff", "analyst")

_PERMISSIONS: dict[str, set[str]] = {
    "owner": {
        "*",
    },
    "org_admin": {
        "org:read", "org:update",
        "clinics:read", "clinics:write",
        "staff:read", "staff:write",
        "receptionists:read", "receptionists:write",
        "appointments:read", "appointments:write",
        "knowledge:read", "knowledge:write",
        "calls:read",
        "analytics:read",
        "audit:read",
        "callbacks:read", "callbacks:write",
        "usage:read",
    },
    "clinic_admin": {
        "org:read",
        "clinics:read", "clinics:write",
        "staff:read",
        "receptionists:read", "receptionists:write",
        "appointments:read", "appointments:write",
        "knowledge:read", "knowledge:write",
        "calls:read",
        "analytics:read",
        "audit:read",
        "callbacks:read", "callbacks:write",
        "usage:read",
    },
    "staff": {
        "org:read",
        "clinics:read",
        "receptionists:read",
        "appointments:read", "appointments:write",
        "knowledge:read",
        "calls:read",
        "callbacks:read", "callbacks:write",
        "analytics:read",
    },
    "analyst": {
        "org:read",
        "clinics:read",
        "appointments:read",
        "calls:read",
        "analytics:read",
        "audit:read",
        "usage:read",
    },
}


def role_has_permission(role: str, permission: str) -> bool:
    perms = _PERMISSIONS.get(role, set())
    if "*" in perms:
        return True
    if permission in perms:
        return True
    # "resource:write" implies "resource:read"
    return permission.endswith(":read") and permission.replace(":read", ":write") in perms


def permissions_for_role(role: str) -> list[str]:
    return sorted(_PERMISSIONS.get(role, set()))
