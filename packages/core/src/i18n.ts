/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/** Minimal i18n: en + hi strings for CLI messages. */

const STRINGS: Record<string, Record<string, string>> = {
  en: {
    logged_in: "Logged in with API key.",
    logged_out: "Logged out.",
    not_logged_in: "Not logged in.",
    session_not_found: "session not found",
  },
  hi: {
    logged_in: "API key se login ho gaya.",
    logged_out: "Logout ho gaya.",
    not_logged_in: "Login nahi hai.",
    session_not_found: "session nahi mila",
  },
}

export function t(key: string, locale: string = process.env.TRAYAMBAK_LOCALE ?? "en"): string {
  return STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? key
}
